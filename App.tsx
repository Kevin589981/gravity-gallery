import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppConfig, ImageFile, SortMode, SortDirection, OrientationFilter } from './types';
import { DEFAULT_CONFIG } from './constants';
import { isImageFile, createImageObject, shuffleArray, preloadImageAsBlob, naturalSort } from './utils/imageUtils';
import Landing from './components/Landing';
import GalleryView from './components/GalleryView';
import ControlPanel from './components/ControlPanel';
import SettingsModal from './components/SettingsModal';
import { Icons } from './components/Icon';

const STORAGE_KEY = 'gravity_gallery_state_v1';
const PRELOAD_BATCH_SIZE = 5;

const App: React.FC = () => {
    const [allImages, setAllImages] = useState<ImageFile[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
    const [isPaused, setIsPaused] = useState(false);
    const [isUIOpen, setIsUIOpen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [noMatchesFound, setNoMatchesFound] = useState(false);

    const uiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    
    // 【修改点 1】新增：用于同步跟踪正在预加载的图片ID，防止重复请求
    const preloadInProgress = useRef<Set<string>>(new Set());

    // Persistence: Load on mount
    useEffect(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (parsed.config) setConfig(parsed.config);

                // Auto-connect if server info exists
                if (parsed.config?.serverUrl && parsed.config?.selectedServerPaths) {
                    fetchServerPlaylist(
                        parsed.config.serverUrl,
                        parsed.config.selectedServerPaths,
                        parsed.config.sortMode,
                        parsed.config.sortDirection,
                        parsed.config.orientationFilter
                    );
                }
            } catch (e) {
                console.error("Failed to load saved state", e);
            }
        }
    }, []);

    // Persistence: Save on change
    useEffect(() => {
        if (config.serverUrl) {
            const stateToSave = {
                config: config
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
        }
    }, [config]);

    // --- SERVER FETCH LOGIC ---
    useEffect(() => {
        if (isLoading) return;

        if (config.serverUrl && config.selectedServerPaths) {
            fetchServerPlaylist(
                config.serverUrl,
                config.selectedServerPaths,
                config.sortMode,
                config.sortDirection,
                config.orientationFilter
            );
        } else if (!config.serverUrl) {
            // Local Mode Logic - Apply sorting locally
            if (config.sortMode === SortMode.Shuffle) {
                setAllImages(prev => shuffleArray(prev));
                setCurrentIndex(0);
            } else if (config.sortMode === SortMode.Sequential) {
                setAllImages(prev => [...prev].sort((a, b) => naturalSort(a.name, b.name)));
                setCurrentIndex(0);
            }
            if (config.sortDirection === SortDirection.Reverse) {
                setAllImages(prev => [...prev].reverse());
                setCurrentIndex(0);
            }
        }
    }, [config.sortMode, config.sortDirection, config.orientationFilter]);


    // --- 【修改点 2】Preload Logic 修复竞态条件 ---
    useEffect(() => {
        if (allImages.length === 0) return;

        const indicesToPreload: number[] = [];
        for (let i = 1; i <= PRELOAD_BATCH_SIZE; i++) {
            const nextIdx = (currentIndex + i) % allImages.length;
            const img = allImages[nextIdx];
            
            // 核心修改：增加 check "preloadInProgress.current.has(img.id)"
            // 只有当图片未加载且当前也没有正在加载时，才推入队列
            if (img && !img.file && !img.dimsLoaded && !img.blobUrl && !preloadInProgress.current.has(img.id)) {
                indicesToPreload.push(nextIdx);
            }
        }

        if (indicesToPreload.length === 0) return;

        indicesToPreload.forEach(async (idx) => {
            const img = allImages[idx];
            if (!img) return;

            // 立即标记为正在处理
            preloadInProgress.current.add(img.id);

            try {
                const { blobUrl, isLandscape } = await preloadImageAsBlob(img.url);

                setAllImages(prev => {
                    const newArr = [...prev];
                    // Check if the image at this index is still the same
                    if (newArr[idx] && newArr[idx].id === img.id) {
                        newArr[idx] = {
                            ...newArr[idx],
                            blobUrl,
                            isLandscape,
                            dimsLoaded: true
                        };
                    }
                    return newArr;
                });
                // 成功后无需立即从 Set 移除，因为 state 中已有 blobUrl 会阻挡下一次请求
            } catch (e) {
                // 失败时移除标记，以便后续（如下一轮循环或重试机制）可以再次尝试
                preloadInProgress.current.delete(img.id);
            }
        });
    }, [currentIndex, allImages.length]); // 依赖项保持不变，实际内容由 allImages[idx] 获取

    // Handle Folder Selection (Local Mode)
    const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            setIsLoading(true);
            
            // 【修改点 3】清理旧的加载标记
            preloadInProgress.current.clear();

            const fileList = Array.from(e.target.files);
            const validFiles = fileList.filter(isImageFile);

            if (validFiles.length === 0) {
                alert("No images found in this folder.");
                setIsLoading(false);
                return;
            }

            const processedImages = await Promise.all(validFiles.map(createImageObject));
            let sorted = processedImages;

            if (config.sortMode === SortMode.Shuffle) {
                sorted = shuffleArray(processedImages);
            } else {
                sorted = processedImages.sort((a, b) => naturalSort(a.name, b.name));
            }

            if (config.sortDirection === SortDirection.Reverse) {
                sorted = sorted.reverse();
            }

            setAllImages(sorted);
            setConfig(prev => ({ ...prev, serverUrl: undefined, selectedServerPaths: undefined }));
            setCurrentIndex(0);
            setNoMatchesFound(false);
            setIsLoading(false);
            setIsUIOpen(true);
            resetUITimer();
        }
    };

    const fetchServerPlaylist = async (
        url: string,
        paths: string[],
        sort: SortMode,
        direction: SortDirection,
        orientation: OrientationFilter
    ) => {
        setIsLoading(true);
        // 【修改点 3】清理旧的加载标记
        preloadInProgress.current.clear();

        try {
            const base = url.endsWith('/') ? url.slice(0, -1) : url;
            const api = `${base}/api/playlist`;

            let sortStr = 'name';
            if (sort === SortMode.Shuffle) sortStr = 'shuffle';
            else if (sort === SortMode.Date) sortStr = 'date';
            else if (sort === SortMode.SubfolderRandom) sortStr = 'subfolder_random';
            else if (sort === SortMode.SubfolderDate) sortStr = 'subfolder_date';
            else sortStr = 'name';

            const res = await fetch(api, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    paths: paths,
                    sort: sortStr,
                    direction: direction.toLowerCase(),
                    orientation: orientation
                })
            });

            if (!res.ok) throw new Error("Failed to get playlist");
            const relPaths: string[] = await res.json();

            if (relPaths.length === 0) {
                setAllImages([]);
                setNoMatchesFound(true);
            } else {
                const imageObjects = relPaths.map(relPath => {
                    const fullUrl = `${base}/${relPath}`;
                    return {
                        id: relPath,
                        url: fullUrl,
                        name: relPath.split('/').pop() || 'Image',
                        isLandscape: false
                    };
                });

                setAllImages(imageObjects);
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

    const handleServerStart = (url: string, paths: string[]) => {
        setConfig(prev => ({ ...prev, serverUrl: url, selectedServerPaths: paths }));
        fetchServerPlaylist(url, paths, config.sortMode, config.sortDirection, config.orientationFilter);
    };

    const loadDemoImages = async () => {
        setIsLoading(true);
        // 【修改点 3】清理旧的加载标记
        preloadInProgress.current.clear();

        const demoUrls = [
            'https://picsum.photos/1920/1080',
            'https://picsum.photos/1080/1920',
            'https://picsum.photos/2000/3000',
            'https://picsum.photos/3000/2000',
            'https://picsum.photos/1500/1500',
        ];
        const processed = await Promise.all(demoUrls.map((u, i) => createImageObject(`${u}?r=${i}`)));
        setAllImages(shuffleArray(processed));
        setConfig(prev => ({ ...prev, serverUrl: undefined, selectedServerPaths: undefined }));
        setCurrentIndex(0);
        setNoMatchesFound(false);
        setIsLoading(false);
        setIsUIOpen(true);
        resetUITimer();
    };

    const nextImage = useCallback(() => {
        if (allImages.length === 0) return;
        setCurrentIndex((prev) => (prev + 1) % allImages.length);
    }, [allImages.length]);

    const prevImage = useCallback(() => {
        if (allImages.length === 0) return;
        setCurrentIndex((prev) => (prev - 1 + allImages.length) % allImages.length);
    }, [allImages.length]);

    // Timer Logic
    useEffect(() => {
        if (isPaused || allImages.length === 0 || showSettings || noMatchesFound) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            return;
        }

        intervalRef.current = setInterval(() => {
            nextImage();
        }, config.refreshInterval * 1000);

        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [isPaused, allImages.length, config.refreshInterval, nextImage, showSettings, noMatchesFound]);

    const resetUITimer = useCallback(() => {
        if (showSettings) return;
        setIsUIOpen(true);
        if (uiTimeoutRef.current) clearTimeout(uiTimeoutRef.current);
        uiTimeoutRef.current = setTimeout(() => {
            if (!showSettings) setIsUIOpen(false);
        }, 3000);
    }, [showSettings]);

    const handleScreenTap = () => {
        resetUITimer();
    };

    if (isLoading) {
        return (
            <div className="h-screen w-screen bg-black flex flex-col items-center justify-center space-y-4">
                <Icons.Refresh className="w-8 h-8 text-blue-500 animate-spin" />
                <p className="text-neutral-400 animate-pulse">Loading Playlist...</p>
            </div>
        );
    }

    if (allImages.length === 0 && !noMatchesFound) {
        return (
            <Landing
                onFolderSelect={handleFolderSelect}
                onServerConnectAndPlay={handleServerStart}
                onLoadDemo={loadDemoImages}
                initialServerUrl={config.serverUrl}
            />
        );
    }

    const safeIndex = currentIndex >= allImages.length ? 0 : currentIndex;
    const currentImage = allImages[safeIndex];

    if (noMatchesFound) {
        return (
            <div className="h-screen w-screen bg-black flex flex-col items-center justify-center space-y-6 p-6 text-center">
                <div className="w-16 h-16 bg-neutral-800 rounded-full flex items-center justify-center">
                    <Icons.FilterX className="w-8 h-8 text-neutral-400" />
                </div>
                <div>
                    <h2 className="text-xl font-bold text-white">No Images Found</h2>
                    <p className="text-neutral-400 mt-2">The current filter returned no results.</p>
                </div>
                <button
                    onClick={() => setShowSettings(true)}
                    className="bg-blue-600 px-6 py-3 rounded-xl font-bold text-white hover:bg-blue-500 transition-colors"
                >
                    Open Settings
                </button>

                <SettingsModal
                    isOpen={showSettings}
                    onClose={() => {
                        setShowSettings(false);
                    }}
                    config={config}
                    onConfigChange={setConfig}
                    fileCount={allImages.length}
                    onReselectFolder={() => { 
                        setAllImages([]); 
                        setShowSettings(false); 
                        localStorage.removeItem(STORAGE_KEY);
                        preloadInProgress.current.clear(); // 【修改点 3】清空 Set
                    }}
                />
            </div>
        )
    }

    return (
        <div className="relative h-screen w-screen overflow-hidden bg-black">
            <GalleryView
                image={currentImage}
                config={config}
                isPaused={isPaused}
                onNext={() => { nextImage(); resetUITimer(); }}
                onPrev={() => { prevImage(); resetUITimer(); }}
                onTap={handleScreenTap}
            />

            <ControlPanel
                visible={isUIOpen}
                isPaused={isPaused}
                onTogglePause={() => { setIsPaused(!isPaused); resetUITimer(); }}
                onNext={() => { nextImage(); resetUITimer(); }}
                onPrev={() => { prevImage(); resetUITimer(); }}
                onSettings={() => { setShowSettings(true); setIsPaused(true); }}
            />

            <SettingsModal
                isOpen={showSettings}
                onClose={() => { setShowSettings(false); setIsPaused(false); resetUITimer(); }}
                config={config}
                onConfigChange={setConfig}
                fileCount={allImages.length}
                onReselectFolder={() => { 
                    setAllImages([]); 
                    setShowSettings(false); 
                    localStorage.removeItem(STORAGE_KEY);
                    preloadInProgress.current.clear(); // 【修改点 3】清空 Set
                }}
            />
        </div>
    );
};

export default App;