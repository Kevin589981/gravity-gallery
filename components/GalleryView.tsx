import React, { useEffect, useState, useRef } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { ImageFile, AppConfig, FitMode } from '../types';

interface GalleryViewProps {
  image: ImageFile | null;
  config: AppConfig;
  isPaused: boolean;
  onNext: () => void;
  onPrev: () => void;
  onSwipeNext: () => void;
  onSwipePrev: () => void;
  onTap: () => void;
}

const GalleryView: React.FC<GalleryViewProps> = ({
  image,
  config,
  isPaused,
  onNext,
  onPrev,
  onSwipeNext,
  onSwipePrev,
  onTap
}) => {
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  // Double buffering state
  const [displayImage, setDisplayImage] = useState<ImageFile | null>(image);
  const [prevImage, setPrevImage] = useState<ImageFile | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  const lastTapTimeRef = useRef<number>(0);
  const lastTapTimeForDoubleTapRef = useRef<number>(0);
  const doubleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTransformingRef = useRef(false);
  const currentScaleRef = useRef(1);
  const [isPanningEnabled, setIsPanningEnabled] = useState(false);
  const [hideSwipeLayer, setHideSwipeLayer] = useState(false);

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
    if (isTransformingRef.current || currentScaleRef.current > 1.01) return;
    if (e.touches.length !== 1) {
      touchStartX.current = null;
      touchEndX.current = null;
      return;
    }
    // Single finger: swipe start
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isTransformingRef.current || currentScaleRef.current > 1.01) return;
    if (e.touches.length !== 1) return;
    // Single finger swipe
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (isTransformingRef.current || currentScaleRef.current > 1.01) {
      touchStartX.current = null;
      touchEndX.current = null;
      return;
    }
    // Handle swipe
    if (!touchStartX.current || !touchEndX.current) {
      if (touchStartX.current && !touchEndX.current) {
        const now = Date.now();
        if (now - lastTapTimeRef.current > 250) {
          onTap();
          lastTapTimeRef.current = now;
        }
      }
      touchStartX.current = null;
      touchEndX.current = null;
      return;
    }

    const distance = touchStartX.current - touchEndX.current;
    const isLeftSwipe = distance > 80;
    const isRightSwipe = distance < -80;

    if (isLeftSwipe) {
      onSwipeNext();
    } else if (isRightSwipe) {
      onSwipePrev();
    } else {
      onTap();
    }

    touchStartX.current = null;
    touchEndX.current = null;
  };

  const handleImageLoad = () => {
    // New image loaded, remove previous and reset zoom
    setIsTransitioning(false);
    setPrevImage(null);
    setHideSwipeLayer(false);
  };

  if (!displayImage && !prevImage) return <div className="w-full h-full bg-black" />;

  return (
    <div
      className="relative w-full h-full bg-black flex items-center justify-center"
      onClick={(e) => { e.preventDefault(); }}
    >
      {/* Swipe Layer (only when not zoomed) */}
      {!isPanningEnabled && !hideSwipeLayer && (
        <div
          className="absolute inset-0 z-30"
          onTouchStart={(e) => { 
            if (e.touches.length === 2) {
              // Two fingers detected - hide layer and let event pass through
              setHideSwipeLayer(true);
              return; // Don't stop propagation, let pinch gesture reach the library
            }
            if (e.touches.length === 1) {
              const now = Date.now();
              const timeSinceLastTap = now - lastTapTimeForDoubleTapRef.current;
              
              // Double tap detection (within 300ms)
              if (timeSinceLastTap < 300 && timeSinceLastTap > 0) {
                // Double tap detected - hide layer and let event pass through to zoom library
                if (doubleTapTimerRef.current) {
                  clearTimeout(doubleTapTimerRef.current);
                  doubleTapTimerRef.current = null;
                }
                setHideSwipeLayer(true);
                setTimeout(() => setHideSwipeLayer(false), 100);
                return; // Don't stop propagation, let double tap reach the library
              }
              
              lastTapTimeForDoubleTapRef.current = now;
              e.stopPropagation(); 
              handleTouchStart(e); 
            }
          }}
          onTouchMove={(e) => { 
            if (e.touches.length === 1) {
              e.stopPropagation(); 
              handleTouchMove(e); 
            }
          }}
          onTouchEnd={(e) => { 
            if (e.changedTouches.length === 1 && e.touches.length === 0) {
              e.stopPropagation(); 
              handleTouchEnd(); 
            }
          }}
          style={{ pointerEvents: hideSwipeLayer ? 'none' : 'auto' }}
        />
      )}
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
          <TransformWrapper
            minScale={1}
            maxScale={5}
            doubleClick={{ disabled: false, step: 2 }}
            wheel={{ disabled: true }}
            panning={{ disabled: !isPanningEnabled }}
            pinch={{ step: 5 }}
            key={displayImage.id}
            limitToBounds={false}
            centerOnInit={true}
            onZoom={({ state }) => {
              currentScaleRef.current = state.scale;
              const isZoomed = state.scale > 1.01;
              setIsPanningEnabled(isZoomed);
              if (!isZoomed) setHideSwipeLayer(false);
            }}
            onZoomStop={({ state }) => {
              currentScaleRef.current = state.scale;
              const isZoomed = state.scale > 1.01;
              setIsPanningEnabled(isZoomed);
              if (!isZoomed) setHideSwipeLayer(false);
            }}
            onPinchingStart={() => { isTransformingRef.current = true; }}
            onPinchingStop={({ state }) => {
              currentScaleRef.current = state.scale;
              const isZoomed = state.scale > 1.01;
              isTransformingRef.current = isZoomed;
              setIsPanningEnabled(isZoomed);
              if (!isZoomed) setHideSwipeLayer(false);
            }}
            onPanningStart={() => { isTransformingRef.current = true; }}
            onPanningStop={({ state }) => {
              currentScaleRef.current = state.scale;
              const isZoomed = state.scale > 1.01;
              isTransformingRef.current = isZoomed;
              setIsPanningEnabled(isZoomed);
              if (!isZoomed) setHideSwipeLayer(false);
            }}
          >
            <TransformComponent wrapperStyle={{ width: '100%', height: '100%', overflow: 'visible' }} contentStyle={{ width: '100%', height: '100%', overflow: 'visible' }}>
              <SingleImageView
                image={displayImage}
                config={config}
                windowSize={windowSize}
                onLoad={handleImageLoad}
              />
            </TransformComponent>
          </TransformWrapper>
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
        fetchPriority="high"
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