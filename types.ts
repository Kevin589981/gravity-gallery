export enum FitMode {
  Cover = 'Cover',
  Contain = 'Contain',
}

export enum SortMode {
  Shuffle = 'Shuffle',
  Sequential = 'Sequential', // Name A-Z
  Date = 'Date', // Newest first
}

export enum OrientationFilter {
  Both = 'Both',
  Landscape = 'Landscape',
  Portrait = 'Portrait',
}

export interface AppConfig {
  refreshInterval: number; // in seconds
  fitMode: FitMode;
  autoRotate: boolean; // If true, rotates landscape images on portrait screens
  showInfo: boolean;
  sortMode: SortMode;
  orientationFilter: OrientationFilter;
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