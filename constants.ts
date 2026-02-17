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

export const DEFAULT_SERVER_HOSTNAME = '<hostname>';
export const DEFAULT_SERVER_URL = `https://${DEFAULT_SERVER_HOSTNAME}.local:4860`;
// You can change this IP to match your computer's local IP
export const FALLBACK_SERVER_URL = 'https://<ip>:4860';

export const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
