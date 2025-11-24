import { AppConfig, FitMode, SortMode, OrientationFilter } from './types';

export const DEFAULT_CONFIG: AppConfig = {
  refreshInterval: 5,
  fitMode: FitMode.Contain,
  autoRotate: true,
  showInfo: true,
  sortMode: SortMode.Shuffle,
  orientationFilter: OrientationFilter.Both,
};

// You can change this IP to match your computer's local IP
export const DEFAULT_SERVER_URL = 'http://<ip>:8000';

export const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];