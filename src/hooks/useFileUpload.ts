import { useState, useCallback } from 'react';
import { Attachment } from '../types/message.types';
import { getPlatform } from '../platform';
import { v4 as uuidv4 } from 'uuid';

interface UploadProgress {
  [fileId: string]: number;
}

/**
 * Turns picked files into attachments the model can read. How that happens is
 * up to the host (`platform.files.upload`): desktop uploads to Open WebUI or
 * extracts text locally; the web app uploads to its own server.
 */
export function useFileUpload() {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress>({});
  const [error, setError] = useState<string | null>(null);

  const uploadFile = useCallback(async (file: File): Promise<Attachment | null> => {
    const progressId = uuidv4();
    setUploading(true);
    setError(null);

    try {
      return await getPlatform().files.upload(file, (value) => {
        setProgress((prev) => ({ ...prev, [progressId]: value }));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      return null;
    } finally {
      setProgress((prev) => {
        const next = { ...prev };
        delete next[progressId];
        return next;
      });
      setUploading(false);
    }
  }, []);

  const uploadFiles = useCallback(
    async (files: File[]): Promise<Attachment[]> => {
      const results = await Promise.all(files.map((file) => uploadFile(file)));
      return results.filter((attachment): attachment is Attachment => attachment !== null);
    },
    [uploadFile]
  );

  return {
    uploadFile,
    uploadFiles,
    uploading,
    progress,
    error,
  };
}
