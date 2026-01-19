import { AppConfig, FitMode, SortMode, SortDirection, OrientationFilter, ControlRevealMode } from './types';

export const DEFAULT_CONFIG: AppConfig = {
    refreshInterval: 5,
    fitMode: FitMode.Contain,
    autoRotate: true,
    showInfo: true,
    sortMode: SortMode.Shuffle,
    sortDirection: SortDirection.Forward, // NEW: Default direction
    orientationFilter: OrientationFilter.Both,
    controlRevealMode: ControlRevealMode.Tap,
};

// You can change this IP to match your computer's local IP
export const DEFAULT_SERVER_URL = 'http://<ip>:4860';

export const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
