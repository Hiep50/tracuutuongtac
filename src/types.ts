export interface Drug {
  name: string;
  dosage: string;
  frequency: string;
}

export interface Interaction {
  severity: "CRITICAL" | "MODERATE" | "MINOR";
  drugs: string;
  description: string;
}

export interface DocumentFile {
  id: string;
  fileName: string;
  fileSize: string;
  dateString: string;
  status: "scanning" | "analyzed" | "failed";
  progress?: number;
  statusText?: string;
  drugs: Drug[];
  interactions: Interaction[];
}

export interface StorageSettings {
  autoDelete: boolean;
  encryptBackup: boolean;
}
