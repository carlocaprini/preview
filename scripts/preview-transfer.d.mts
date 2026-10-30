export function trustedOrigin(): string;
export function download(planPath: string, destinationPath: string): Promise<void>;
export function pdfUpload(sourcePath: string, planPath: string): Promise<void>;
export function main(argv?: string[]): Promise<void>;
