import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Set up bodies up to 20MB for PDF/Image uploads
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

// Lazy initializer for Gemini client
let aiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "MY_GEMINI_API_KEY" || key.trim() === "") {
      throw new Error("GEMINI_API_KEY environment variable is missing or blank in Settings > Secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Highly resilient helper to handle temporary 503 (high demand) & 429 (quota exceeded) errors with retries and fallback models
async function callGeminiWithFallback(params: {
  contents: any;
  config?: any;
}): Promise<{ response: any; modelUsed: string }> {
  const ai = getGenAI();
  const modelsToTry = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
  let lastError: any = null;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[Gemini API] Querying model: ${model} (Attempt ${attempt}/2)`);
        const response = await ai.models.generateContent({
          model,
          contents: params.contents,
          config: params.config,
        });
        
        if (response && response.text) {
          console.log(`[Gemini API] Successful response from model: ${model}`);
          return { response, modelUsed: model };
        }
        throw new Error("Empty response text returned from model.");
      } catch (err: any) {
        lastError = err;
        const errStr = String(err?.message || err?.status || JSON.stringify(err) || err).toLowerCase();
        console.warn(`[Gemini API] Error using model ${model} (Attempt ${attempt}/2):`, errStr);

        const isTemporary = errStr.includes("503") || errStr.includes("unavailable") || errStr.includes("temp") ||
                            errStr.includes("429") || errStr.includes("quota") || errStr.includes("limit") || errStr.includes("exhausted");

        // Delay slightly on retryable transients
        if (isTemporary && attempt < 2) {
          const delaySec = attempt * 0.5;
          console.log(`[Gemini API] Transient medical API error detected. Retrying in ${delaySec}s...`);
          await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
        } else {
          // Break inner loop to try the fallback model immediately
          break;
        }
      }
    }
  }

  throw lastError || new Error("Failed after attempting multiple models and retries.");
}

// -------------------------------------------------------------
// API Endpoint: Analyze Document (PDF or Image)
// -------------------------------------------------------------
app.post("/api/analyze-file", async (req, res) => {
  try {
    const { fileData, mimeType, fileName } = req.body;
    if (!fileData || !mimeType) {
      return res.status(400).json({ error: "Missing fileData or mimeType" });
    }

    const ai = getGenAI();

    // Prompts Gemini to parse the PDF/image as a medical document
    const systemInstruction = 
      "You are an expert clinical pharmacologist. Analyze the provided medical document (prescription, medical report, or lab test) " +
      "and extract: 1) The standard clinical names of all active medications, along with their dosages and frequencies. " +
      "2) Any clinically significant drug-to-drug interactions among these extracted medications. " +
      "If there are no interactions, return an empty interactions array. " +
      "Formulate your response in clean, Vietnamese language, especially drug descriptions, interaction danger labels, and clinical explanations.";

    const schema = {
      type: Type.OBJECT,
      properties: {
        fileName: { type: Type.STRING },
        drugs: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING, description: "Standard clinical name of the drug, e.g. Metformin Hydrochloride" },
              dosage: { type: Type.STRING, description: "Dosage, e.g. 500mg" },
              frequency: { type: Type.STRING, description: "Frequency or note, e.g. 2 lần/ngày (Sáng/Tối)" }
            },
            required: ["name"]
          }
        },
        interactions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              severity: { type: Type.STRING, description: "Must be 'CRITICAL' (Nghiêm trọng) or 'MODERATE' (Trung bình) or 'MINOR' (Nhẹ/Theo dõi)" },
              drugs: { type: Type.STRING, description: "The pair of interacting drugs, e.g. Lisinopril ↔ Ibuprofen" },
              description: { type: Type.STRING, description: "Detailed medical explanation in Vietnamese of why they interact and key clinical recommendations" }
            },
            required: ["severity", "drugs", "description"]
          }
        }
      },
      required: ["drugs", "interactions"]
    };

    let modelUsed = "gemini-3.5-flash";
    let textResult = "";
    try {
      const result = await callGeminiWithFallback({
        contents: [
          {
            inlineData: {
              data: fileData,
              mimeType: mimeType
            }
          },
          {
            text: `Please parse this file named "${fileName || 'document.pdf'}". Extract medications and analyze their drug-to-drug interactions.`
          }
        ],
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: schema
        }
      });
      textResult = result.response.text;
      modelUsed = result.modelUsed;
    } catch (apiError: any) {
      console.error("All Gemini API attempts failed during file analysis:", apiError);
      return res.status(200).json({
        success: false,
        quotaExceeded: true,
        error: "Trình phân tích đám mây đang gặp sự cố quá tải hoặc hết hạn ngạch (503/429). Đã chủ động chuyển hướng quy trình sang kết quả Dược điển lâm phác đồ ngoại tuyến."
      });
    }

    if (!textResult) {
      throw new Error("No output text returned from model.");
    }

    const parsedData = JSON.parse(textResult);
    return res.json({
      success: true,
      data: {
        fileName: fileName || parsedData.fileName || "document.pdf",
        drugs: parsedData.drugs || [],
        interactions: parsedData.interactions || [],
        modelUsed: modelUsed
      }
    });

  } catch (error: any) {
    console.error("Error analyzing file in backend:", error);
    return res.status(200).json({
      success: false,
      quotaExceeded: true,
      error: "Không thể kết nối đến Trình kiểm tra đám mây. Đã đồng bộ ngược quy trình sang Cơ sở dữ liệu ngoại tuyến để đảm bảo an toàn."
    });
  }
});


// -------------------------------------------------------------
// API Endpoint: Custom check / update of interactions
// -------------------------------------------------------------
app.post("/api/check-interactions", async (req, res) => {
  try {
    const { drugs } = req.body;
    if (!drugs || !Array.isArray(drugs)) {
      return res.status(400).json({ error: "Invalid 'drugs' parameter. Must be an array." });
    }

    if (drugs.length < 2) {
      return res.json({ success: true, data: { interactions: [] } });
    }

    const ai = getGenAI();

    const systemInstruction =
      "You are an expert medical pharmacologist checking drug-to-drug interactions. " +
      "Identify all clinically documented interactions among the list of medications provided. " +
      "Explain the severity (CRITICAL, MODERATE, or MINOR) and mechanism/recommendation clearly in Vietnamese.";

    const schema = {
      type: Type.OBJECT,
      properties: {
        interactions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              severity: { type: Type.STRING, description: "CRITICAL or MODERATE or MINOR" },
              drugs: { type: Type.STRING, description: "e.g. DrugA ↔ DrugB" },
              description: { type: Type.STRING, description: "Clinical description and advice in Vietnamese" }
            },
            required: ["severity", "drugs", "description"]
          }
        }
      },
      required: ["interactions"]
    };

    const drugListText = drugs.map(d => `${d.name} (${d.dosage || "N/A"} - ${d.frequency || "N/A"})`).join(", ");

    let modelUsed = "gemini-3.5-flash";
    let textResult = "";
    try {
      const result = await callGeminiWithFallback({
        contents: `Please verify if there are any clinically significant interactions in this list of medications: ${drugListText}.`,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: schema
        }
      });
      textResult = result.response.text;
      modelUsed = result.modelUsed;
    } catch (apiError: any) {
      console.error("All Gemini API attempts failed during interaction check:", apiError);
      return res.status(200).json({
        success: false,
        quotaExceeded: true,
        error: "Trình rà soát đám mây đang tạm thời bận hoặc quá giới hạn (503/429). Đã chủ động kích hoạt Trình phân tích rủi ro dược lý lâm sàng nội tuyến."
      });
    }

    if (!textResult) {
      throw new Error("No output text returned from model.");
    }

    const parsedData = JSON.parse(textResult);
    return res.json({
      success: true,
      data: {
        interactions: parsedData.interactions || [],
        modelUsed: modelUsed
      }
    });

  } catch (error: any) {
    console.error("Error checking interactions in backend:", error);
    return res.status(200).json({
      success: false,
      quotaExceeded: true,
      error: "Hệ thống kiểm tra lâm sàng đám mây đang tạm thời phản hồi chậm. Báo cáo dược lý hiện đã tự động đồng bộ chéo về cơ sở lâm sàng tại chỗ."
    });
  }
});


// -------------------------------------------------------------
// Vite Middleware / Static Asset Serving
// -------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in development mode with Vite HMR integration...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in production mode serving static assets...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // SPA fallback
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on target port ${PORT}`);
    console.log(`Access standard local/preview through reverse proxy`);
  });
}

startServer();
