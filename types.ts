export enum FitMode {
    Cover = 'Cover',
    Contain = 'Contain',
}

export enum SortMode {
    Shuffle = 'Shuffle',
    Sequential = 'Sequential', // Name A-Z (Natural Sort)
    Date = 'Date', // Newest first
    SubfolderRandom = 'SubfolderRandom', // Subfolder Random > File Name
    SubfolderDate = 'SubfolderDate', // Subfolder Date > File Name
}

export enum SortDirection {
    Forward = 'Forward',
    Reverse = 'Reverse',
}

export enum OrientationFilter {
    Both = 'Both',
    Landscape = 'Landscape',
    Portrait = 'Portrait',
}

export enum ControlRevealMode {
    Tap = 'Tap',
    CornerButton = 'CornerButton',
}

export interface AppConfig {
    refreshInterval: number; // in seconds
    preloadCount: number; // Number of images to preload on each side of current image
    cacheReserveCount: number; // Extra number of images kept on each side in cache window
    fitMode: FitMode;
    autoRotate: boolean; // If true, rotates landscape images on portrait screens
    showInfo: boolean;
    sortMode: SortMode;
    sortDirection: SortDirection; // NEW: Direction control
    orientationFilter: OrientationFilter;
    controlRevealMode: ControlRevealMode;
    serverUrl?: string;
    selectedServerPaths?: string[]; // Folders selected on server
}

export interface ImageFile {
    id: string;
    file?: File;
    url: string;
    blobUrl?: string; // Cache: Local Blob URL
    dimsLoaded?: boolean; // Cache: Have we pre-fetched dimensions?
    name: string;
    isLandscape: boolean;
}

export interface FileSystemEntry {
    name: string;
    path: string; // Relative path
    type: 'folder' | 'file';
}

export interface BrowseResponse {
    currentPath: string;
    items: FileSystemEntry[];
}
