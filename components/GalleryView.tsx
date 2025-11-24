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

  // Double buffering state
  const [displayImage, setDisplayImage] = useState<ImageFile | null>(image);
  const [prevImage, setPrevImage] = useState<ImageFile | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  // Sync props to state
  useEffect(() => {
    if (image?.id !== displayImage?.id) {
      // Start transition: Keep current as prev, set new as display
      setPrevImage(displayImage);
      setDisplayImage(image);
      setIsTransitioning(true);
    }
  }, [image]);

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

  const handleImageLoad = () => {
    // New image loaded, remove previous
    setIsTransitioning(false);
    setPrevImage(null);
  };

  if (!displayImage && !prevImage) return <div className="w-full h-full bg-black" />;

  return (
    <div
      className="relative w-full h-full overflow-hidden bg-black flex items-center justify-center"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClick={(e) => { e.preventDefault(); }}
    >
      {/* Previous Image (Background) */}
      {prevImage && (
        <div className="absolute inset-0 z-0">
          <SingleImageView
            image={prevImage}
            config={config}
            windowSize={windowSize}
          />
        </div>
      )}

      {/* Current Image (Foreground) */}
      {displayImage && (
        <div className={`absolute inset-0 z-10 transition-opacity duration-300 ${isTransitioning && prevImage ? 'opacity-0' : 'opacity-100'}`}>
          <SingleImageView
            image={displayImage}
            config={config}
            windowSize={windowSize}
            onLoad={handleImageLoad}
          />
        </div>
      )}

      {/* Info Overlay */}
      {config.showInfo && displayImage && (
        <div className={`absolute top-[calc(1rem_+_env(safe-area-inset-top))] left-4 z-20 pointer-events-none transition-opacity duration-300 ${isPaused ? 'opacity-100' : 'opacity-0'}`}>
          <div className="bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full border border-white/10">
            <p className="text-xs text-white/80 truncate max-w-[200px]">{displayImage.name}</p>
          </div>
        </div>
      )}
    </div>
  );
};

// Reusable Single Image Component
const SingleImageView = ({ image, config, windowSize, onLoad }: any) => {
  // We trust image.isLandscape from the preloader/backend first.
  // We update it via onLoad just in case it wasn't preloaded.
  const [isActualLandscape, setIsActualLandscape] = useState(image.isLandscape);

  // Sync state if the prop updates
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
      className="w-full h-full flex items-center justify-center"
      style={rotationStyle}
    >
      <img
        key={image.id}
        src={image.blobUrl || image.url}
        alt={image.name}
        className={`${config.fitMode === FitMode.Cover ? 'object-cover w-full h-full' : 'object-contain max-w-full max-h-full'}`}
        draggable={false}
        loading="eager"
        decoding="sync"
        onLoad={(e) => {
          const isL = e.currentTarget.naturalWidth >= e.currentTarget.naturalHeight;
          if (isL !== isActualLandscape) {
            setIsActualLandscape(isL);
          }
          if (onLoad) onLoad();
        }}
      />
    </div>
  );
}

export default GalleryView;