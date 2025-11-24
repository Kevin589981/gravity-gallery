import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppConfig, ImageFile, SortMode, OrientationFilter } from './types';
import { DEFAULT_CONFIG } from './constants';
import { isImageFile, createImageObject, shuffleArray, preloadImageAsBlob } from './utils/imageUtils';
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
  // Re-fetch playlist when Sort Mode OR Orientation Filter changes (Backend handles filtering now)
  useEffect(() => {
    if (isLoading) return; 

    if (config.serverUrl && config.selectedServerPaths) {
        fetchServerPlaylist(config.serverUrl, config.selectedServerPaths, config.sortMode, config.orientationFilter);
    } else if (!config.serverUrl) {
        // Local Mode Logic
        if (config.sortMode === SortMode.Shuffle) {
            setAllImages(prev => shuffleArray(prev));
            setCurrentIndex(0);
        } else if (config.sortMode === SortMode.Sequential) {
             setAllImages(prev => [...prev].sort((a,b) => a.name.localeCompare(b.name)));
             setCurrentIndex(0);
        }
    }
  }, [config.sortMode, config.orientationFilter]); 


  // --- Preload Logic ---
  useEffect(() => {
    if (allImages.length === 0) return;

    const indicesToPreload: number[] = [];
    for (let i = 1; i <= PRELOAD_BATCH_SIZE; i++) {
        const nextIdx = (currentIndex + i) % allImages.length;
        const img = allImages[nextIdx];
        // Only preload remote images that haven't been loaded yet
        if (img && !img.file && !img.dimsLoaded && !img.blobUrl) {
            indicesToPreload.push(nextIdx);
        }
    }

    if (indicesToPreload.length === 0) return;

    indicesToPreload.forEach(async (idx) => {
        const img = allImages[idx];
        if (!img) return;
        
        try {
            const { blobUrl, isLandscape } = await preloadImageAsBlob(img.url);
            
            // Update state with cached blob and dimension info
            setAllImages(prev => {
                const newArr = [...prev];
                // Check if the image at this index is still the same (array might have been reshuffled)
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
        } catch (e) {
            // Silently fail preloading
        }
    });
  }, [currentIndex, allImages.length]);

  // Handle Folder Selection (Local Mode)
  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setIsLoading(true);
      const fileList = Array.from(e.target.files);
      const validFiles = fileList.filter(isImageFile);

      if (validFiles.length === 0) {
        alert("No images found in this folder.");
        setIsLoading(false);
        return;
      }

      const processedImages = await Promise.all(validFiles.map(createImageObject));
      const sorted = config.sortMode === SortMode.Shuffle ? shuffleArray(processedImages) : processedImages.sort((a,b)=>a.name.localeCompare(b.name));
      
      setAllImages(sorted);
      setConfig(prev => ({...prev, serverUrl: undefined, selectedServerPaths: undefined }));
      setCurrentIndex(0);
      setNoMatchesFound(false);
      setIsLoading(false);
      setIsUIOpen(true);
      resetUITimer();
    }
  };

  const fetchServerPlaylist = async (url: string, paths: string[], sort: SortMode, orientation: OrientationFilter) => {
      setIsLoading(true);
      try {
        const base = url.endsWith('/') ? url.slice(0, -1) : url;
        const api = `${base}/api/playlist`;

        // Send request to backend with all filter parameters
        const res = await fetch(api, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                paths: paths,
                sort: sort === SortMode.Shuffle ? 'shuffle' : sort === SortMode.Date ? 'date' : 'name',
                orientation: orientation // Backend now handles this!
            })
        });

        if (!res.ok) throw new Error("Failed to get playlist");
        const relPaths: string[] = await res.json();

        if (relPaths.length === 0) {
            setAllImages([]);
            setNoMatchesFound(true); // Backend says no matches
        } else {
            const imageObjects = relPaths.map(relPath => {
                const fullUrl = `${base}/${relPath}`; 
                return {
                    id: relPath,
                    url: fullUrl,
                    name: relPath.split('/').pop() || 'Image',
                    isLandscape: false // Will be updated by preloader
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
      fetchServerPlaylist(url, paths, config.sortMode, config.orientationFilter);
  };

  const loadDemoImages = async () => {
    setIsLoading(true);
    const demoUrls = [
        'https://picsum.photos/1920/1080',
        'https://picsum.photos/1080/1920',
        'https://picsum.photos/2000/3000',
        'https://picsum.photos/3000/2000',
        'https://picsum.photos/1500/1500',
    ];
    const processed = await Promise.all(demoUrls.map((u, i) => createImageObject(`${u}?r=${i}`)));
    setAllImages(shuffleArray(processed));
    setConfig(prev => ({...prev, serverUrl: undefined, selectedServerPaths: undefined}));
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
                onReselectFolder={() => { setAllImages([]); setShowSettings(false); localStorage.removeItem(STORAGE_KEY); }}
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
        onReselectFolder={() => { setAllImages([]); setShowSettings(false); localStorage.removeItem(STORAGE_KEY); }}
      />
    </div>
  );
};

export default App;