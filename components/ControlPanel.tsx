import React from 'react';
import { Icons } from './Icon';

interface ControlPanelProps {
  visible: boolean;
  isPaused: boolean;
  onTogglePause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSettings: () => void;
}

const ControlPanel: React.FC<ControlPanelProps> = ({
  visible,
  isPaused,
  onTogglePause,
  onNext,
  onPrev,
  onSettings,
}) => {
  return (
    <div
      className={`absolute bottom-0 left-0 right-0 p-6 pb-[calc(2.5rem_+_env(safe-area-inset-bottom))] bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 flex justify-center items-end gap-8 z-50 ${
        visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
      }`}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onSettings(); }}
        className="p-4 rounded-full bg-white/10 backdrop-blur-md active:bg-white/20 transition-all"
      >
        <Icons.Settings className="w-6 h-6 text-white" />
      </button>

      <button
        onClick={(e) => { e.stopPropagation(); onPrev(); }}
        className="p-4 rounded-full bg-white/10 backdrop-blur-md active:bg-white/20 transition-all"
      >
        <Icons.Prev className="w-8 h-8 text-white" />
      </button>

      <button
        onClick={(e) => { e.stopPropagation(); onTogglePause(); }}
        className="p-6 rounded-full bg-white text-black shadow-lg active:scale-95 transition-transform"
      >
        {isPaused ? (
          <Icons.Play className="w-8 h-8 fill-current" />
        ) : (
          <Icons.Pause className="w-8 h-8 fill-current" />
        )}
      </button>

      <button
        onClick={(e) => { e.stopPropagation(); onNext(); }}
        className="p-4 rounded-full bg-white/10 backdrop-blur-md active:bg-white/20 transition-all"
      >
        <Icons.Next className="w-8 h-8 text-white" />
      </button>
      
      {/* Spacer for alignment symmetry */}
      <div className="w-2" />
    </div>
  );
};

export default ControlPanel;