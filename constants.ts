import { AppConfig, FitMode, SortMode, SortDirection, OrientationFilter, ControlRevealMode } from './types';

export const DEFAULT_CONFIG: AppConfig = {
    refreshInterval: 5,
    preloadCount: 5,
    cacheReserveCount: 20,
    fitMode: FitMode.Contain,
    autoRotate: true,
    showInfo: true,
    sortMode: SortMode.Shuffle,
    sortDirection: SortDirection.Forward, // NEW: Default direction
    orientationFilter: OrientationFilter.Both,
    controlRevealMode: ControlRevealMode.Tap,
};


export const DEFAULT_SERVER_HOSTNAME = process.env.VITE_DEFAULT_SERVER_HOSTNAME;
export const DEFAULT_SERVER_PORT = process.env.VITE_DEFAULT_SERVER_PORT;
export const DEFAULT_SERVER_URL = `https://${DEFAULT_SERVER_HOSTNAME}.local:${DEFAULT_SERVER_PORT}`;

export const FALLBACK_SERVER_URL = process.env.VITE_FALLBACK_SERVER_URL

export const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
