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

/**
 * Natural sort comparison function
 * Properly sorts strings containing numbers (e.g., "img1" < "img2" < "img10")
 */
export const naturalSort = (a: string, b: string): number => {
    const regex = /(\d+)|(\D+)/g;
    const aParts = a.match(regex) || [];
    const bParts = b.match(regex) || [];

    const minLength = Math.min(aParts.length, bParts.length);

    for (let i = 0; i < minLength; i++) {
        const aPart = aParts[i];
        const bPart = bParts[i];

        const aNum = parseInt(aPart, 10);
        const bNum = parseInt(bPart, 10);

        // Both are numbers
        if (!isNaN(aNum) && !isNaN(bNum)) {
            if (aNum !== bNum) {
                return aNum - bNum;
            }
        } else {
            // At least one is not a number, do string comparison
            const cmp = aPart.localeCompare(bPart, undefined, { sensitivity: 'base' });
            if (cmp !== 0) {
                return cmp;
            }
        }
    }

    // If all parts matched, the shorter one comes first
    return aParts.length - bParts.length;
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

type FetchPriorityHint = 'high' | 'low' | 'auto';

interface PreloadImageOptions {
    priority?: FetchPriorityHint;
    signal?: AbortSignal;
}

export const preloadImageAsBlob = async (
    url: string,
    options: PreloadImageOptions = {}
): Promise<{ blobUrl: string; isLandscape: boolean }> => {
    try {
        const requestOptions: RequestInit & { priority?: FetchPriorityHint } = {
            priority: options.priority ?? 'low',
            signal: options.signal,
        };

        const response = await fetch(url, requestOptions);
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
