import { ImageFile } from '../types';
import { SUPPORTED_EXTENSIONS } from '../constants';

export const isImageFile = (file: File): boolean => {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return extension ? SUPPORTED_EXTENSIONS.includes(extension) : false;
};

export const shuffleArray = <T,>(array: T[]): T[] => {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
};

export const createImageObject = (source: File | string): Promise<ImageFile> => {
  return new Promise((resolve) => {
    let url: string;
    let name: string;
    let file: File | undefined;

    if (source instanceof File) {
      url = URL.createObjectURL(source);
      name = source.name;
      file = source;
    } else {
      url = source;
      name = source.split('/').pop() || 'Remote Image';
      file = undefined;
    }

    const img = new Image();
    img.onload = () => {
      resolve({
        id: Math.random().toString(36).substring(7),
        file,
        url,
        // For local files, the URL is already a blob URL so we mark it as loaded
        blobUrl: source instanceof File ? url : undefined,
        dimsLoaded: true,
        name,
        isLandscape: img.width >= img.height,
      });
    };
    img.onerror = () => {
      // Fallback if image is corrupt or fails to load
      console.warn(`Failed to load image: ${name}`);
      resolve({
        id: Math.random().toString(36).substring(7),
        file,
        url,
        name,
        isLandscape: false, // Default to portrait/square if unknown
      });
    };
    img.src = url;
  });
};

export const preloadImageAsBlob = async (url: string): Promise<{ blobUrl: string; isLandscape: boolean }> => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resolve({
          blobUrl,
          isLandscape: img.width >= img.height
        });
      };
      img.onerror = () => reject(new Error('Failed to load image dimensions'));
      img.src = blobUrl;
    });
  } catch (e) {
    throw new Error('Network error during preload');
  }
};