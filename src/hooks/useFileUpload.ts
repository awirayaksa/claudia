import { useState, useCallback } from 'react';
import { getOpenWebUIService } from '../services/api/openWebUI.service';
import { useAppSelector } from '../store';
import { Attachment } from '../types/message.types';
import { v4 as uuidv4 } from 'uuid';

interface UploadProgress {
  [fileId: string]: number;
}

export function useFileUpload() {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress>({});
  const [error, setError] = useState<string | null>(null);
  const { baseUrl, apiKey } = useAppSelector((state) => state.settings.api);

  const uploadFile = useCallback(
    async (file: File): Promise<Attachment | null> => {
      if (!baseUrl || !apiKey) {
        setError('API not configured');
        return null;
      }

      const fileId = uuidv4();
      setUploading(true);
      setError(null);

      try {
        const service = getOpenWebUIService(baseUrl, apiKey);

        const uploadedId = await service.uploadFile(file, (progressValue) => {
          setProgress((prev) => ({ ...prev, [fileId]: progressValue }));
        });

        const attachment: Attachment = {
          id: fileId,
          type: file.type.startsWith('image/') ? 'image' : 'file',
          name: file.name,
          size: file.size,
          mimeType: file.type,
          url: `${baseUrl}/api/v1/files/${uploadedId}`,
        };

        setProgress((prev) => {
          const newProgress = { ...prev };
          delete newProgress[fileId];
          return newProgress;
        });

        return attachment;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
        setProgress((prev) => {
          const newProgress = { ...prev };
          delete newProgress[fileId];
          return newProgress;
        });
        return null;
      } finally {
        setUploading(false);
      }
    },
    [baseUrl, apiKey]
  );

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
