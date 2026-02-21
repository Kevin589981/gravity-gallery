import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppConfig, ImageFile, SortMode, SortDirection, OrientationFilter, ControlRevealMode } from './types';
import { DEFAULT_CONFIG } from './constants';
import { isImageFile, createImageObject, shuffleArray, preloadImageAsBlob, naturalSort } from './utils/imageUtils';
import Landing from './components/Landing';
import GalleryView from './components/GalleryView';
import ControlPanel from './components/ControlPanel';
import SettingsModal from './components/SettingsModal';
import { Icons } from './components/Icon';

const STORAGE_KEY = 'gravity_gallery_state_v1';
const SERVER_PLAYLIST_SNAPSHOT_KEY = 'gravity_gallery_server_playlist_snapshot_v1';
const MIN_PRELOAD_COUNT = 1;
const MAX_PRELOAD_COUNT = 20;
const MIN_CACHE_RESERVE_COUNT = 0;
const MAX_CACHE_RESERVE_COUNT = 100;
const PRELOAD_CONCURRENCY = 2;

interface ServerPlaylistSnapshot {
    serverUrl: string;
    selectedServerPaths: string[];
    criteriaSignature: string;
    playlist: string[];
    currentIndex: number;
    updatedAt: number;
}

interface SessionStatusResponse {
    has_session: boolean;
    source: 'memory' | 'database' | null;
    playlist_size: number;
}

interface SessionPlaylistResponse {
    has_session: boolean;
    source: 'memory' | 'database' | null;
    playlist_size: number;
    playlist: string[];
    criteria?: {
        sort: string;
        direction: string;
        orientation: string;
        paths: string[];
    } | null;
}

interface PlaylistCriteriaInput {
    serverUrl: string;
    selectedPaths: string[];
    sort: SortMode;
    direction: SortDirection;
    orientation: OrientationFilter;
}

const loadPersistedConfig = (): AppConfig => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return DEFAULT_CONFIG;
        const parsed = JSON.parse(saved);
        const mergedConfig: AppConfig = parsed?.config ? { ...DEFAULT_CONFIG, ...parsed.config } : DEFAULT_CONFIG;
        return mergedConfig;
    } catch {
        return DEFAULT_CONFIG;
    }
};

const App: React.FC = () => {
    const [allImages, setAllImages] = useState<ImageFile[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [config, setConfig] = useState<AppConfig>(() => loadPersistedConfig());
    const [isPaused, setIsPaused] = useState(false);
    const [isUIOpen, setIsUIOpen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [noMatchesFound, setNoMatchesFound] = useState(false);

    const uiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const preloadInProgress = useRef<Set<string>>(new Set());
    const preloadedBlobCache = useRef<Map<string, { blobUrl: string; isLandscape: boolean }>>(new Map());
    const preloadScheduleTokenRef = useRef(0);
    const allImagesRef = useRef<ImageFile[]>([]);
    const playlistVersionRef = useRef(0);
    const playlistFetchSeqRef = useRef(0);
    const pendingServerFetchRef = useRef<{
        url: string;
        paths: string[];
        sort: SortMode;
        direction: SortDirection;
        orientation: OrientationFilter;
        currentPath: string | null;
        reason: 'auto' | 'user';
    } | null>(null);

    // 标记“用户手动修改筛选条件（影响播放列表的 criteria）”，用于跳过自动恢复逻辑。
    const userCriteriaChangeRef = useRef(false);
    
    // 用于防止在设置更改时 useEffect 多次触发 fetch
    const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clampPreloadCount = (value: number) => {
        if (!Number.isFinite(value)) return DEFAULT_CONFIG.preloadCount;
        return Math.max(MIN_PRELOAD_COUNT, Math.min(MAX_PRELOAD_COUNT, Math.floor(value)));
    };

    const clampCacheReserveCount = (value: number) => {
        if (!Number.isFinite(value)) return DEFAULT_CONFIG.cacheReserveCount;
        return Math.max(MIN_CACHE_RESERVE_COUNT, Math.min(MAX_CACHE_RESERVE_COUNT, Math.floor(value)));
    };

    const releaseServerBlobUrls = useCallback((images: ImageFile[]) => {
        images.forEach((img) => {
            if (img.blobUrl && !img.file) {
                URL.revokeObjectURL(img.blobUrl);
            }
        });
    }, []);

    const clearPreloadedBlobCache = useCallback(() => {
        preloadedBlobCache.current.forEach(({ blobUrl }) => {
            URL.revokeObjectURL(blobUrl);
        });
        preloadedBlobCache.current.clear();
    }, []);

    const readServerPlaylistSnapshot = useCallback((): ServerPlaylistSnapshot | null => {
        const raw = localStorage.getItem(SERVER_PLAYLIST_SNAPSHOT_KEY);
        if (!raw) return null;

        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            if (!Array.isArray(parsed.playlist) || !Array.isArray(parsed.selectedServerPaths)) return null;
            if (typeof parsed.serverUrl !== 'string') return null;
            if (typeof parsed.criteriaSignature !== 'string') return null;
            const currentIndex = Number.isFinite(parsed.currentIndex) ? Math.floor(parsed.currentIndex) : 0;

            return {
                serverUrl: parsed.serverUrl,
                selectedServerPaths: parsed.selectedServerPaths,
                criteriaSignature: parsed.criteriaSignature,
                playlist: parsed.playlist,
                currentIndex,
                updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : Date.now(),
            };
        } catch {
            return null;
        }
    }, []);

    const writeServerPlaylistSnapshot = useCallback((snapshot: ServerPlaylistSnapshot) => {
        localStorage.setItem(SERVER_PLAYLIST_SNAPSHOT_KEY, JSON.stringify(snapshot));
    }, []);

    const clearServerPlaylistSnapshot = useCallback(() => {
        localStorage.removeItem(SERVER_PLAYLIST_SNAPSHOT_KEY);
    }, []);

    const buildCriteriaSignature = useCallback((criteria: PlaylistCriteriaInput): string => {
        const normalizedUrl = criteria.serverUrl.endsWith('/') ? criteria.serverUrl.slice(0, -1) : criteria.serverUrl;
        return JSON.stringify({
            serverUrl: normalizedUrl,
            selectedPaths: criteria.selectedPaths,
            sort: criteria.sort,
            direction: criteria.direction,
            orientation: criteria.orientation,
        });
    }, []);

    const resetUITimer = useCallback(() => {
        if (showSettings) return;
        setIsUIOpen(true);
        if (uiTimeoutRef.current) clearTimeout(uiTimeoutRef.current);
        uiTimeoutRef.current = setTimeout(() => {
            if (!showSettings) setIsUIOpen(false);
        }, 3000);
    }, [showSettings]);

    const applyServerPlaylist = useCallback((baseUrl: string, relPaths: string[], desiredIndex: number) => {
        const imageObjects = relPaths.map(relPath => ({
            id: relPath,
            url: `${baseUrl}/api/file?path=${encodeURIComponent(relPath)}`,
            name: relPath.split('/').pop() || 'Image',
            isLandscape: false
        }));

        playlistVersionRef.current += 1;
        setAllImages(prev => {
            releaseServerBlobUrls(prev);
            return imageObjects;
        });

        const maxIndex = Math.max(0, imageObjects.length - 1);
        const safeIndex = Math.max(0, Math.min(desiredIndex, maxIndex));
        setCurrentIndex(safeIndex);
        setNoMatchesFound(false);
        setIsUIOpen(true);
        resetUITimer();
    }, [releaseServerBlobUrls, resetUITimer]);

    const tryResumeServerPlaylist = useCallback(async (
        url: string,
        selectedPaths: string[],
        sort: SortMode,
        direction: SortDirection,
        orientation: OrientationFilter
    ): Promise<boolean> => {
        const normalizedUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const snapshot = readServerPlaylistSnapshot();
        const currentCriteriaSignature = buildCriteriaSignature({
            serverUrl: normalizedUrl,
            selectedPaths,
            sort,
            direction,
            orientation,
        });

        const snapshotMatchesCurrentSelection = !!snapshot
            && normalizedUrl === (snapshot.serverUrl.endsWith('/') ? snapshot.serverUrl.slice(0, -1) : snapshot.serverUrl)
            && JSON.stringify(snapshot.selectedServerPaths) === JSON.stringify(selectedPaths)
            && snapshot.criteriaSignature === currentCriteriaSignature;

        if (snapshot && !snapshotMatchesCurrentSelection) {
            return false;
        }

        try {
            const statusRes = await fetch(`${normalizedUrl}/api/session-status`);
            if (!statusRes.ok) return false;

            const statusData: SessionStatusResponse = await statusRes.json();

            if (statusData?.has_session) {
                const playlistRes = await fetch(`${normalizedUrl}/api/session-playlist`);
                if (!playlistRes.ok) return false;

                const playlistData: SessionPlaylistResponse = await playlistRes.json();
                const sessionPaths = Array.isArray(playlistData?.playlist) ? playlistData.playlist : [];
                if (sessionPaths.length === 0) return false;

                const desiredIndex = snapshotMatchesCurrentSelection
                    ? snapshot!.currentIndex
                    : 0;

                preloadScheduleTokenRef.current += 1;
                preloadInProgress.current.clear();
                clearPreloadedBlobCache();

                applyServerPlaylist(normalizedUrl, sessionPaths, desiredIndex);
                writeServerPlaylistSnapshot({
                    serverUrl: normalizedUrl,
                    selectedServerPaths: selectedPaths,
                    criteriaSignature: currentCriteriaSignature,
                    playlist: sessionPaths,
                    currentIndex: Math.max(0, Math.min(desiredIndex, sessionPaths.length - 1)),
                    updatedAt: Date.now(),
                });
                return true;
            }

            if (!snapshotMatchesCurrentSelection) return false;
            if (!Array.isArray(snapshot!.playlist) || snapshot!.playlist.length === 0) return false;

            const restoreRes = await fetch(`${normalizedUrl}/api/restore-playlist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    playlist: snapshot!.playlist,
                    current_index: snapshot!.currentIndex,
                    criteria: {
                        sort,
                        direction,
                        orientation,
                        paths: selectedPaths,
                    }
                })
            });

            if (!restoreRes.ok) return false;

            const restoreData: any = await restoreRes.json();
            const restoredPaths = Array.isArray(restoreData?.playlist) ? restoreData.playlist : [];
            if (restoredPaths.length === 0) return false;

            const restoredIndex = Number.isFinite(restoreData?.current_index)
                ? restoreData.current_index
                : snapshot!.currentIndex;

            preloadScheduleTokenRef.current += 1;
            preloadInProgress.current.clear();
            clearPreloadedBlobCache();

            applyServerPlaylist(normalizedUrl, restoredPaths, restoredIndex);

            writeServerPlaylistSnapshot({
                serverUrl: normalizedUrl,
                selectedServerPaths: selectedPaths,
                criteriaSignature: currentCriteriaSignature,
                playlist: restoredPaths,
                currentIndex: Math.max(0, Math.min(restoredIndex, restoredPaths.length - 1)),
                updatedAt: Date.now(),
            });
            return true;
        } catch {
            return false;
        }
    }, [applyServerPlaylist, buildCriteriaSignature, clearPreloadedBlobCache, readServerPlaylistSnapshot, writeServerPlaylistSnapshot]);

    useEffect(() => {
        allImagesRef.current = allImages;
    }, [allImages]);

    useEffect(() => {
        return () => {
            releaseServerBlobUrls(allImagesRef.current);
            clearPreloadedBlobCache();
            preloadInProgress.current.clear();
        };
    }, [clearPreloadedBlobCache, releaseServerBlobUrls]);

    // Persistence: Save on change
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ config }));
        } catch {
            // ignore quota / private mode errors
        }
    }, [config]);

    const handleConfigChange = useCallback((newConfig: AppConfig) => {
        setConfig((prev) => {
            const criteriaChanged =
                prev.serverUrl !== newConfig.serverUrl ||
                JSON.stringify(prev.selectedServerPaths ?? []) !== JSON.stringify(newConfig.selectedServerPaths ?? []) ||
                prev.sortMode !== newConfig.sortMode ||
                prev.sortDirection !== newConfig.sortDirection ||
                prev.orientationFilter !== newConfig.orientationFilter;

            if (criteriaChanged) {
                userCriteriaChangeRef.current = true;
            }
            return newConfig;
        });
    }, []);

    // --- SERVER FETCH LOGIC (triggered by config changes) ---
    useEffect(() => {
        // Debounce fetch calls
        if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
        
        fetchDebounceRef.current = setTimeout(() => {
            if (config.serverUrl && config.selectedServerPaths) {
                const currentImagePath = allImages.length > 0 ? allImages[currentIndex]?.id : null;

                const reason: 'auto' | 'user' = userCriteriaChangeRef.current ? 'user' : 'auto';
                userCriteriaChangeRef.current = false;

                const currentPathForRequest = (reason === 'user' && !config.startFromCurrentOnCriteriaChange)
                    ? null
                    : currentImagePath;

                // If a fetch is already in-flight, queue the latest desired fetch instead of skipping.
                pendingServerFetchRef.current = {
                    url: config.serverUrl,
                    paths: config.selectedServerPaths,
                    sort: config.sortMode,
                    direction: config.sortDirection,
                    orientation: config.orientationFilter,
                    currentPath: currentPathForRequest,
                    reason,
                };

                if (!isLoading) {
                    const req = pendingServerFetchRef.current;
                    pendingServerFetchRef.current = null;
                    if (req) {
                        (async () => {
                            if (req.reason === 'auto') {
                                const restored = await tryResumeServerPlaylist(req.url, req.paths, req.sort, req.direction, req.orientation);
                                if (!restored) {
                                    fetchServerPlaylist(req.url, req.paths, req.sort, req.direction, req.orientation, req.currentPath);
                                }
                            } else {
                                fetchServerPlaylist(req.url, req.paths, req.sort, req.direction, req.orientation, req.currentPath);
                            }
                        })();
                    }
                }
            } else if (!config.serverUrl) {
                // Local Mode Logic
                let sorted = [...allImages];
                if (config.sortMode === SortMode.Shuffle) {
                    sorted = shuffleArray(sorted);
                } else {
                    sorted = sorted.sort((a, b) => naturalSort(a.name, b.name));
                }
                if (config.sortDirection === SortDirection.Reverse) {
                    sorted.reverse();
                }
                playlistVersionRef.current += 1;
                setAllImages(sorted);
                setCurrentIndex(0);
            }
        }, 300); // 300ms debounce

        return () => {
            if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
        };
    }, [config.serverUrl, config.selectedServerPaths, config.sortMode, config.sortDirection, config.orientationFilter, tryResumeServerPlaylist]);

    // If a server playlist fetch was skipped due to loading, run it once loading ends.
    useEffect(() => {
        if (isLoading) return;
        const req = pendingServerFetchRef.current;
        if (!req) return;
        pendingServerFetchRef.current = null;
        (async () => {
            if (req.reason === 'auto') {
                const restored = await tryResumeServerPlaylist(req.url, req.paths, req.sort, req.direction, req.orientation);
                if (!restored) {
                    fetchServerPlaylist(req.url, req.paths, req.sort, req.direction, req.orientation, req.currentPath);
                }
            } else {
                fetchServerPlaylist(req.url, req.paths, req.sort, req.direction, req.orientation, req.currentPath);
            }
        })();
    }, [isLoading, tryResumeServerPlaylist]);

    useEffect(() => {
        if (!config.serverUrl || !config.selectedServerPaths) return;
        if (allImages.length === 0) return;

        writeServerPlaylistSnapshot({
            serverUrl: config.serverUrl,
            selectedServerPaths: config.selectedServerPaths,
            criteriaSignature: buildCriteriaSignature({
                serverUrl: config.serverUrl,
                selectedPaths: config.selectedServerPaths,
                sort: config.sortMode,
                direction: config.sortDirection,
                orientation: config.orientationFilter,
            }),
            playlist: allImages.map(img => img.id),
            currentIndex,
            updatedAt: Date.now(),
        });
    }, [buildCriteriaSignature, config.orientationFilter, config.selectedServerPaths, config.serverUrl, config.sortDirection, config.sortMode, allImages, currentIndex, writeServerPlaylistSnapshot]);

    // --- Preload Logic ---
    useEffect(() => {
        if (allImages.length === 0) return;
        const scheduleToken = ++preloadScheduleTokenRef.current;

        // Capture the current playlist version to prevent stale preload results
        // from being applied after a playlist refresh.
        const playlistVersion = playlistVersionRef.current;

        const preloadCount = clampPreloadCount(config.preloadCount);
        const seenIndices = new Set<number>();
        const orderedIndices: number[] = [];
        for (let i = 1; i <= preloadCount; i++) {
            const nextIdx = (currentIndex + i) % allImages.length;
            const prevIdx = (currentIndex - i + allImages.length) % allImages.length;

            if (!seenIndices.has(nextIdx)) {
                seenIndices.add(nextIdx);
                orderedIndices.push(nextIdx);
            }
            if (!seenIndices.has(prevIdx)) {
                seenIndices.add(prevIdx);
                orderedIndices.push(prevIdx);
            }
        }

        const preloadTargets = orderedIndices.filter((idx) => {
            const img = allImages[idx];
            return !!img && !img.blobUrl && !preloadInProgress.current.has(img.id);
        });

        const preloadAtIndex = async (idx: number, priority: 'high' | 'low') => {
            const img = allImages[idx];
            if (!img) return;

            const cached = preloadedBlobCache.current.get(img.url);
            if (cached) {
                if (playlistVersionRef.current !== playlistVersion) return;
                setAllImages(prev => {
                    const newArr = [...prev];
                    if (newArr[idx] && newArr[idx].id === img.id && !newArr[idx].blobUrl) {
                        newArr[idx] = { ...newArr[idx], blobUrl: cached.blobUrl, isLandscape: cached.isLandscape, dimsLoaded: true };
                    }
                    return newArr;
                });
                return;
            }

            if (preloadInProgress.current.has(img.id)) return;

            preloadInProgress.current.add(img.id);
            try {
                const { blobUrl, isLandscape } = await preloadImageAsBlob(img.url, {
                    priority,
                });

                preloadedBlobCache.current.set(img.url, { blobUrl, isLandscape });

                // If playlist changed while we were preloading, drop the result.
                if (playlistVersionRef.current !== playlistVersion) return;

                setAllImages(prev => {
                    const newArr = [...prev];
                    if (newArr[idx] && newArr[idx].id === img.id) {
                        newArr[idx] = { ...newArr[idx], blobUrl, isLandscape, dimsLoaded: true };
                    }
                    return newArr;
                });
            } catch (e: any) {
            } finally {
                // Always release the lock. Otherwise a playlist refresh can make an image
                // permanently appear "in-progress" even if its blobUrl was never attached.
                preloadInProgress.current.delete(img.id);
            }
        };

        const preloadWithPriority = async () => {
            if (preloadTargets.length === 0) return;
            if (scheduleToken !== preloadScheduleTokenRef.current) return;

            const [firstIdx, ...restIndices] = preloadTargets;
            if (firstIdx !== undefined) {
                await preloadAtIndex(firstIdx, 'high');
            }

            if (restIndices.length === 0) return;
            if (scheduleToken !== preloadScheduleTokenRef.current) return;

            const workerCount = Math.max(1, Math.min(PRELOAD_CONCURRENCY, restIndices.length));
            let cursor = 0;

            const worker = async () => {
                while (scheduleToken === preloadScheduleTokenRef.current) {
                    const idx = restIndices[cursor++];
                    if (idx === undefined) break;
                    await preloadAtIndex(idx, 'low');
                }
            };

            await Promise.all(Array.from({ length: workerCount }, () => worker()));
        };

        void preloadWithPriority();

        return () => {
            // 只停止旧批次继续派发，不中断已在进行的下载，避免重复下载与黑屏。
        };
    }, [currentIndex, allImages, config.preloadCount]);

    // Keep memory bounded: retain only nearby server blobs and cache entries.
    useEffect(() => {
        if (allImages.length === 0) return;

        const preloadCount = clampPreloadCount(config.preloadCount);
        const cacheReserveCount = clampCacheReserveCount(config.cacheReserveCount);
        const keepRadius = preloadCount + cacheReserveCount;
        const keepIndices = new Set<number>([currentIndex]);

        for (let i = 1; i <= keepRadius; i++) {
            keepIndices.add((currentIndex + i) % allImages.length);
            keepIndices.add((currentIndex - i + allImages.length) % allImages.length);
        }

        const keepSourceUrls = new Set<string>();
        keepIndices.forEach((idx) => {
            const img = allImages[idx];
            if (img) keepSourceUrls.add(img.url);
        });

        const blobUrlsToRevoke = new Set<string>();
        let shouldStripBlobFromState = false;

        allImages.forEach((img, idx) => {
            if (!img.blobUrl || img.file) return;
            if (!keepIndices.has(idx)) {
                shouldStripBlobFromState = true;
                blobUrlsToRevoke.add(img.blobUrl);
            }
        });

        preloadedBlobCache.current.forEach((cached, sourceUrl) => {
            if (!keepSourceUrls.has(sourceUrl)) {
                blobUrlsToRevoke.add(cached.blobUrl);
                preloadedBlobCache.current.delete(sourceUrl);
            }
        });

        if (shouldStripBlobFromState) {
            setAllImages((prev) => {
                let changed = false;
                const next = prev.map((img, idx) => {
                    if (!img.blobUrl || img.file || keepIndices.has(idx)) return img;
                    changed = true;
                    return { ...img, blobUrl: undefined };
                });
                return changed ? next : prev;
            });
        }

        if (blobUrlsToRevoke.size > 0) {
            blobUrlsToRevoke.forEach((blobUrl) => URL.revokeObjectURL(blobUrl));
        }
    }, [allImages, currentIndex, config.preloadCount, config.cacheReserveCount]);


    // --- Core Functions ---
    const fetchServerPlaylist = async (
        url: string,
        paths: string[],
        sort: SortMode,
        direction: SortDirection,
        orientation: OrientationFilter,
        currentPath: string | null
    ) => {
        const fetchSeq = ++playlistFetchSeqRef.current;
        setIsLoading(true);
        preloadScheduleTokenRef.current += 1;
        preloadInProgress.current.clear();
        releaseServerBlobUrls(allImagesRef.current);
        clearPreloadedBlobCache();

        try {
            const base = url.endsWith('/') ? url.slice(0, -1) : url;
            const api = `${base}/api/playlist`;

            let sortStr = 'name';
            if (sort === SortMode.Shuffle) sortStr = 'shuffle';
            else if (sort === SortMode.Date) sortStr = 'date';
            else if (sort === SortMode.SubfolderRandom) sortStr = 'subfolder_random';
            else if (sort === SortMode.SubfolderDate) sortStr = 'subfolder_date';
            else if (sort === SortMode.SubfolderPrefix) sortStr = 'subfolder_prefix';
            
            const body: any = {
                paths,
                sort: sortStr,
                direction: direction.toLowerCase(),
                orientation,
            };
            if (currentPath) {
                body.current_path = currentPath;
            }

            const res = await fetch(api, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok) throw new Error("Failed to get playlist");
            const relPaths: string[] = await res.json();

            // If a newer fetch started after this one, ignore this response.
            if (fetchSeq !== playlistFetchSeqRef.current) return;

            if (relPaths.length === 0) {
                playlistVersionRef.current += 1;
                setAllImages(prev => {
                    releaseServerBlobUrls(prev);
                    return [];
                });
                setNoMatchesFound(true);
            } else {
                const imageObjects = relPaths.map(relPath => ({
                    id: relPath,
                    url: `${base}/api/file?path=${encodeURIComponent(relPath)}`,
                    name: relPath.split('/').pop() || 'Image',
                    isLandscape: false
                }));
                playlistVersionRef.current += 1;
                setAllImages(prev => {
                    releaseServerBlobUrls(prev);
                    return imageObjects;
                });
                setCurrentIndex(0);
                setNoMatchesFound(false);
            }
            setIsUIOpen(true);
            resetUITimer();
        } catch (e: any) {
            console.error(e);
            alert("Failed to connect to server or load playlist.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;
        setIsLoading(true);
        preloadScheduleTokenRef.current += 1;
        preloadInProgress.current.clear();
        clearPreloadedBlobCache();

        const validFiles = Array.from(e.target.files).filter(isImageFile);
        if (validFiles.length === 0) {
            alert("No images found in this folder.");
            setIsLoading(false); return;
        }

        const processedImages = await Promise.all(validFiles.map(createImageObject));
        let sorted = processedImages.sort((a, b) => naturalSort(a.name, b.name));
        if (config.sortMode === SortMode.Shuffle) sorted = shuffleArray(processedImages);
        if (config.sortDirection === SortDirection.Reverse) sorted.reverse();

        playlistVersionRef.current += 1;
        setAllImages(prev => {
            releaseServerBlobUrls(prev);
            return sorted;
        });
        setConfig(prev => ({ ...prev, serverUrl: undefined, selectedServerPaths: undefined }));
        clearServerPlaylistSnapshot();
        setCurrentIndex(0);
        setNoMatchesFound(false);
        setIsLoading(false);
        setIsUIOpen(true);
        resetUITimer();
    };
    
    const handleServerStart = (url: string, paths: string[]) => {
        setConfig(prev => ({ ...prev, serverUrl: url, selectedServerPaths: paths }));
        // Fetch is handled by the debounced config effect.
    };

    const loadDemoImages = async () => {
        setIsLoading(true);
        preloadScheduleTokenRef.current += 1;
        preloadInProgress.current.clear();
        clearPreloadedBlobCache();
        const demoUrls = ['https://picsum.photos/1920/1080', 'https://picsum.photos/1080/1920', 'https://picsum.photos/2000/3000', 'https://picsum.photos/3000/2000', 'https://picsum.photos/1500/1500'];
        const processed = await Promise.all(demoUrls.map((u, i) => createImageObject(`${u}?r=${i}`)));
        playlistVersionRef.current += 1;
        setAllImages(prev => {
            releaseServerBlobUrls(prev);
            return shuffleArray(processed);
        });
        setConfig(prev => ({ ...prev, serverUrl: undefined, selectedServerPaths: undefined }));
        clearServerPlaylistSnapshot();
        setCurrentIndex(0);
        setNoMatchesFound(false);
        setIsLoading(false);
        setIsUIOpen(true);
        resetUITimer();
    };

    const nextImage = useCallback(() => {
        if (allImages.length === 0) return;
        setCurrentIndex(prev => (prev + 1) % allImages.length);
    }, [allImages.length]);

    const prevImage = useCallback(() => {
        if (allImages.length === 0) return;
        setCurrentIndex(prev => (prev - 1 + allImages.length) % allImages.length);
    }, [allImages.length]);

    // Timer Logic
    useEffect(() => {
        if (isPaused || allImages.length === 0 || showSettings || noMatchesFound) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            return;
        }
        intervalRef.current = setInterval(nextImage, config.refreshInterval * 1000);
        return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }, [isPaused, allImages.length, config.refreshInterval, nextImage, showSettings, noMatchesFound]);

    const hideUI = useCallback(() => {
        if (uiTimeoutRef.current) {
            clearTimeout(uiTimeoutRef.current);
            uiTimeoutRef.current = null;
        }
        setIsUIOpen(false);
    }, []);

    const handleTapReveal = useCallback(() => {
        if (showSettings) return;

        if (config.controlRevealMode === ControlRevealMode.Tap) {
            resetUITimer();
            return;
        }

        if (config.controlRevealMode === ControlRevealMode.CornerButton) {
            if (isUIOpen) {
                hideUI();
            }
        }
    }, [config.controlRevealMode, hideUI, isUIOpen, resetUITimer, showSettings]);

    // --- Render Logic ---
    if (isLoading) {
        return (
            <div className="h-screen w-screen bg-black flex flex-col items-center justify-center space-y-4">
                <Icons.Refresh className="w-8 h-8 text-blue-500 animate-spin" />
                <p className="text-neutral-400 animate-pulse">Loading Playlist...</p>
            </div>
        );
    }

    if (allImages.length === 0 && !noMatchesFound) {
        return <Landing onFolderSelect={handleFolderSelect} onServerConnectAndPlay={handleServerStart} onLoadDemo={loadDemoImages} initialServerUrl={config.serverUrl} />;
    }

    const currentImage = allImages[currentIndex] || allImages[0];

    if (noMatchesFound) {
        return (
            <div className="h-screen w-screen bg-black flex flex-col items-center justify-center text-center p-6 space-y-6">
                <div className="w-16 h-16 bg-neutral-800 rounded-full flex items-center justify-center">
                    <Icons.FilterX className="w-8 h-8 text-neutral-400" />
                </div>
                <div>
                    <h2 className="text-xl font-bold text-white">No Images Found</h2>
                    <p className="text-neutral-400 mt-2">The current filter returned no results.</p>
                </div>
                <button onClick={() => setShowSettings(true)} className="bg-blue-600 px-6 py-3 rounded-xl font-bold text-white hover:bg-blue-500 transition-colors">Open Settings</button>
                <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} config={config} onConfigChange={handleConfigChange} fileCount={allImages.length}
                    onReselectFolder={() => { setAllImages(prev => { releaseServerBlobUrls(prev); return []; }); setShowSettings(false); setNoMatchesFound(false); localStorage.removeItem(STORAGE_KEY); clearServerPlaylistSnapshot(); preloadInProgress.current.clear(); clearPreloadedBlobCache(); }}
                />
            </div>
        )
    }

    return (
        <div className="relative h-screen w-screen overflow-hidden bg-black">
            <GalleryView image={currentImage} config={config} isPaused={isPaused} onNext={() => { nextImage(); resetUITimer(); }} onPrev={() => { prevImage(); resetUITimer(); }} onSwipeNext={nextImage} onSwipePrev={prevImage} onTap={handleTapReveal} />
            <ControlPanel visible={isUIOpen} isPaused={isPaused} onTogglePause={() => { setIsPaused(!isPaused); resetUITimer(); }} onNext={() => { nextImage(); resetUITimer(); }} onPrev={() => { prevImage(); resetUITimer(); }} onSettings={() => { setShowSettings(true); setIsPaused(true); }} />

            {config.controlRevealMode === ControlRevealMode.CornerButton && !isUIOpen && (
                <button
                    onClick={(e) => { e.stopPropagation(); resetUITimer(); }}
                    className="absolute bottom-[calc(0.25rem_+_env(safe-area-inset-bottom))] left-4 z-40 w-11 h-11 rounded-full bg-white/25 text-white/90 flex items-center justify-center shadow-lg shadow-black/40 backdrop-blur-md active:scale-95 transition-all"
                    aria-label="Show controls"
                >
                    <Icons.More className="w-6 h-6" />
                </button>
            )}
            <SettingsModal isOpen={showSettings} onClose={() => { setShowSettings(false); setIsPaused(false); resetUITimer(); }} config={config} onConfigChange={handleConfigChange} fileCount={allImages.length}
                onReselectFolder={() => { setAllImages(prev => { releaseServerBlobUrls(prev); return []; }); setShowSettings(false); setNoMatchesFound(false); localStorage.removeItem(STORAGE_KEY); clearServerPlaylistSnapshot(); preloadInProgress.current.clear(); clearPreloadedBlobCache(); }}
            />
        </div>
    );
};

export default App;