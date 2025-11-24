import React, { useEffect, useState, useRef } from 'react';
import { ImageFile, AppConfig, FitMode } from '../types';

interface GalleryViewProps {
  image: ImageFile | null;
  config: AppConfig;
  isPaused: boolean;
  onNext: () => void;
  onPrev: () => void;
  onTap: () => void;
}

const GalleryView: React.FC<GalleryViewProps> = ({ 
    image, 
    config, 
    isPaused, 
    onNext, 
    onPrev, 
    onTap
}) => {
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  // Track window resize
  useEffect(() => {
    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Swipe Logic
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) {
        if (touchStartX.current && !touchEndX.current) {
            onTap();
        }
        touchStartX.current = null;
        touchEndX.current = null;
        return;
    }

    const distance = touchStartX.current - touchEndX.current;
    const isLeftSwipe = distance > 50;
    const isRightSwipe = distance < -50;

    if (isLeftSwipe) {
      onNext();
    } else if (isRightSwipe) {
      onPrev();
    } else {
      onTap();
    }

    touchStartX.current = null;
    touchEndX.current = null;
  };

  if (!image) return <div className="w-full h-full bg-black" />;
  
  return (
    <div 
      className="relative w-full h-full overflow-hidden bg-black flex items-center justify-center"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClick={(e) => { e.preventDefault(); }} 
    >
      <ImageContainer 
          image={image} 
          config={config} 
          windowSize={windowSize} 
      />

      {/* Info Overlay */}
      {config.showInfo && (
        <div className={`absolute top-[calc(1rem_+_env(safe-area-inset-top))] left-4 z-10 pointer-events-none transition-opacity duration-300 ${isPaused ? 'opacity-100' : 'opacity-0'}`}>
           <div className="bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full border border-white/10">
             <p className="text-xs text-white/80 truncate max-w-[200px]">{image.name}</p>
           </div>
        </div>
      )}
    </div>
  );
};

// Sub-component to handle specific image rotation state locally
const ImageContainer = ({ image, config, windowSize }: any) => {
    // We trust image.isLandscape from the preloader/backend first.
    // We update it via onLoad just in case it wasn't preloaded.
    const [isActualLandscape, setIsActualLandscape] = useState(image.isLandscape);

    // Sync state if the prop updates (e.g. preloader finishes while viewing)
    useEffect(() => {
        setIsActualLandscape(image.isLandscape);
    }, [image.id, image.isLandscape]);

    const isPortraitScreen = windowSize.height > windowSize.width;
    const shouldRotate = config.autoRotate && isPortraitScreen && isActualLandscape;

    const rotationStyle: React.CSSProperties = shouldRotate
    ? {
        transform: 'rotate(90deg)',
        width: `${windowSize.height}px`,
        height: `${windowSize.width}px`,
        marginTop: `-${windowSize.width / 2}px`,
        marginLeft: `-${windowSize.height / 2}px`,
        position: 'absolute',
        top: '50%',
        left: '50%',
      }
    : {
        width: '100%',
        height: '100%',
    };

    return (
      <div 
        className="transition-all duration-500 ease-in-out flex items-center justify-center"
        style={rotationStyle}
      >
        <img
          key={image.id}
          // Prefer blobUrl if available for instant load
          src={image.blobUrl || image.url}
          alt={image.name}
          className={`${config.fitMode === FitMode.Cover ? 'object-cover w-full h-full' : 'object-contain max-w-full max-h-full'}`}
          draggable={false}
          loading="eager"
          decoding="sync"
          onLoad={(e) => {
              // Only update rotation logic, do not block visibility
              const isL = e.currentTarget.naturalWidth >= e.currentTarget.naturalHeight;
              if (isL !== isActualLandscape) {
                  setIsActualLandscape(isL);
              }
          }}
        />
      </div>
    );
}

export default GalleryView;