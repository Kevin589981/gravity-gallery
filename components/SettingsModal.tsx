import React from 'react';
import { AppConfig, FitMode, SortMode, SortDirection, OrientationFilter, ControlRevealMode } from '../types';
import { Icons } from './Icon';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    config: AppConfig;
    onConfigChange: (newConfig: AppConfig) => void;
    fileCount: number;
    onReselectFolder: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    onClose,
    config,
    onConfigChange,
    fileCount,
    onReselectFolder
}) => {
    if (!isOpen) return null;

    const updateConfig = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
        onConfigChange({ ...config, [key]: value });
    };

    const handleRescanLibrary = async () => {
        if (!config.serverUrl) return;
        try {
            const base = config.serverUrl.endsWith('/') ? config.serverUrl.slice(0, -1) : config.serverUrl;
            const res = await fetch(`${base}/api/scan`, { method: 'POST' });
            if (res.ok) {
                alert("Scan started! The library will update in the background.");
            } else {
                alert("Failed to trigger scan.");
            }
        } catch (e) {
            alert("Connection error.");
        }
    };

    const handleToggleParentDirAccess = async () => {
        if (!config.serverUrl) return;
        try {
            const base = config.serverUrl.endsWith('/') ? config.serverUrl.slice(0, -1) : config.serverUrl;
            const res = await fetch(`${base}/api/runtime-config/toggle`, { method: 'POST' });
            if (!res.ok) {
                alert("Failed to toggle parent directory access.");
                return;
            }
            const data = await res.json();
            const enabled = !!data.allow_parent_dir_access;
            alert(`Parent directory access is now ${enabled ? 'ON' : 'OFF'}.`);
        } catch (e) {
            alert("Connection error.");
        }
    };

    return (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
            <div className="bg-neutral-900 border border-neutral-800 w-full max-w-md rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
                <div className="p-4 border-b border-neutral-800 flex justify-between items-center bg-neutral-900 sticky top-0">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <Icons.Settings className="w-5 h-5" /> Settings
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-neutral-400 hover:text-white p-2"
                    >
                        Done
                    </button>
                </div>

                <div className="p-6 space-y-8 overflow-y-auto">

                    {/* Library Section */}
                    <div className="space-y-3">
                        <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Library</label>
                        <div className="flex flex-col gap-2 bg-neutral-800/50 p-4 rounded-xl">
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="text-white font-medium">{fileCount} Images Loaded</div>
                                    <div className="text-xs text-neutral-400">{config.serverUrl ? 'Connected to Server' : 'Local Session'}</div>
                                </div>
                                <button
                                    onClick={onReselectFolder}
                                    className="bg-neutral-700 hover:bg-neutral-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                                >
                                    Change
                                </button>
                            </div>

                            {config.serverUrl && (
                                <div className="mt-2 space-y-2">
                                    <button
                                        onClick={handleRescanLibrary}
                                        className="w-full py-2 bg-blue-900/30 text-blue-400 border border-blue-900/50 rounded-lg text-xs font-medium hover:bg-blue-900/50 transition-colors flex items-center justify-center gap-2"
                                    >
                                        <Icons.Refresh className="w-3 h-3" /> Rescan Library for New Files
                                    </button>
                                    <button
                                        onClick={handleToggleParentDirAccess}
                                        className="w-full py-2 bg-amber-900/30 text-amber-300 border border-amber-900/50 rounded-lg text-xs font-medium hover:bg-amber-900/50 transition-colors"
                                    >
                                        Toggle Parent Directory Access
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Filter Section */}
                    <div className="space-y-3">
                        <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Filters</label>
                        <div className="flex flex-col gap-2 bg-neutral-800/50 p-2 rounded-xl">
                            <div className="grid grid-cols-3 gap-1">
                                <button
                                    className={`px-2 py-2 text-xs font-medium rounded-lg transition-all ${config.orientationFilter === OrientationFilter.Both ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-700'}`}
                                    onClick={() => updateConfig('orientationFilter', OrientationFilter.Both)}
                                >
                                    All
                                </button>
                                <button
                                    className={`px-2 py-2 text-xs font-medium rounded-lg transition-all ${config.orientationFilter === OrientationFilter.Landscape ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-700'}`}
                                    onClick={() => updateConfig('orientationFilter', OrientationFilter.Landscape)}
                                >
                                    Landscape
                                </button>
                                <button
                                    className={`px-2 py-2 text-xs font-medium rounded-lg transition-all ${config.orientationFilter === OrientationFilter.Portrait ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-700'}`}
                                    onClick={() => updateConfig('orientationFilter', OrientationFilter.Portrait)}
                                >
                                    Portrait
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Display Section */}
                    <div className="space-y-3">
                        <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Display</label>

                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-neutral-800 rounded-lg">
                                        {config.fitMode === FitMode.Cover ? <Icons.Cover className="w-5 h-5 text-blue-400" /> : <Icons.Contain className="w-5 h-5 text-blue-400" />}
                                    </div>
                                    <span className="text-neutral-200">Fit Mode</span>
                                </div>
                                <div className="flex bg-neutral-800 rounded-lg p-1">
                                    <button
                                        className={`px-3 py-1.5 text-sm rounded-md transition-all ${config.fitMode === FitMode.Cover ? 'bg-blue-600 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}`}
                                        onClick={() => updateConfig('fitMode', FitMode.Cover)}
                                    >
                                        Cover
                                    </button>
                                    <button
                                        className={`px-3 py-1.5 text-sm rounded-md transition-all ${config.fitMode === FitMode.Contain ? 'bg-blue-600 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}`}
                                        onClick={() => updateConfig('fitMode', FitMode.Contain)}
                                    >
                                        Contain
                                    </button>
                                </div>
                            </div>

                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-neutral-800 rounded-lg">
                                        <Icons.Rotate className="w-5 h-5 text-green-400" />
                                    </div>
                                    <div className="flex flex-col">
                                        <span className="text-neutral-200">Auto-Rotate</span>
                                        <span className="text-xs text-neutral-500">Gravity-based fit</span>
                                    </div>
                                </div>
                                <button
                                    onClick={() => updateConfig('autoRotate', !config.autoRotate)}
                                    className={`w-12 h-7 rounded-full transition-colors relative ${config.autoRotate ? 'bg-green-600' : 'bg-neutral-700'}`}
                                >
                                    <div className={`w-5 h-5 bg-white rounded-full absolute top-1 transition-transform ${config.autoRotate ? 'left-6' : 'left-1'}`} />
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Playback Section */}
                    <div className="space-y-3">
                        <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Playback</label>

                        <div className="bg-neutral-800/50 p-4 rounded-xl space-y-4">
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="text-neutral-200">Controls Reveal</span>
                                    <span className="text-xs text-neutral-500">Choose how to show pause/next buttons</span>
                                </div>
                                <div className="flex bg-neutral-900 rounded-lg p-1 border border-neutral-800">
                                    <button
                                        className={`px-3 py-1.5 text-xs rounded-md transition-all ${config.controlRevealMode === ControlRevealMode.Tap ? 'bg-blue-600 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}`}
                                        onClick={() => updateConfig('controlRevealMode', ControlRevealMode.Tap)}
                                    >
                                        Tap screen
                                    </button>
                                    <button
                                        className={`px-3 py-1.5 text-xs rounded-md transition-all ${config.controlRevealMode === ControlRevealMode.CornerButton ? 'bg-blue-600 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}`}
                                        onClick={() => updateConfig('controlRevealMode', ControlRevealMode.CornerButton)}
                                    >
                                        Corner button
                                    </button>
                                </div>
                            </div>

                            <div className="flex justify-between">
                                <span className="text-neutral-200">Interval</span>
                                <span className="text-blue-400 font-mono">{config.refreshInterval}s</span>
                            </div>
                            <input
                                type="range"
                                min="1"
                                max="60"
                                value={config.refreshInterval}
                                onChange={(e) => updateConfig('refreshInterval', parseInt(e.target.value))}
                                className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
                            />
                            <div className="flex justify-between text-xs text-neutral-500">
                                <span>1s</span>
                                <span>30s</span>
                                <span>60s</span>
                            </div>
                        </div>

                        {/* Sort Mode Section - Enhanced with all 5 modes */}
                        <div className="bg-neutral-800/50 p-4 rounded-xl space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-neutral-200 text-sm font-medium">Sort Order</span>
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                <button
                                    className={`px-3 py-2 text-xs rounded-lg transition-all ${config.sortMode === SortMode.Shuffle ? 'bg-purple-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                                    onClick={() => updateConfig('sortMode', SortMode.Shuffle)}
                                    title="Fully Random"
                                >
                                    <Icons.Refresh className="w-4 h-4 mx-auto mb-1" />
                                    <div>Random</div>
                                </button>

                                <button
                                    className={`px-3 py-2 text-xs rounded-lg transition-all ${config.sortMode === SortMode.Sequential ? 'bg-purple-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                                    onClick={() => updateConfig('sortMode', SortMode.Sequential)}
                                    title="Sort by full path (Natural Sort)"
                                >
                                    <span className="font-bold text-sm mx-auto mb-1 block">A-Z</span>
                                    <div>Name</div>
                                </button>

                                <button
                                    className={`px-3 py-2 text-xs rounded-lg transition-all ${config.sortMode === SortMode.Date ? 'bg-purple-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                                    onClick={() => updateConfig('sortMode', SortMode.Date)}
                                    title="Sort by modification date"
                                >
                                    <Icons.Date className="w-4 h-4 mx-auto mb-1" />
                                    <div>Date</div>
                                </button>

                                <button
                                    className={`px-3 py-2 text-xs rounded-lg transition-all ${config.sortMode === SortMode.SubfolderRandom ? 'bg-purple-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                                    onClick={() => updateConfig('sortMode', SortMode.SubfolderRandom)}
                                    title="Subfolders in random order, files sorted naturally within each"
                                >
                                    <div className="text-sm font-bold mb-1">📁🎲</div>
                                    <div>Folder Random</div>
                                </button>

                                <button
                                    className={`px-3 py-2 text-xs rounded-lg transition-all col-span-2 ${config.sortMode === SortMode.SubfolderDate ? 'bg-purple-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}
                                    onClick={() => updateConfig('sortMode', SortMode.SubfolderDate)}
                                    title="Subfolders sorted by date, files sorted naturally within each"
                                >
                                    <div className="text-sm font-bold mb-1">📁📅</div>
                                    <div>Folder by Date</div>
                                </button>
                            </div>
                        </div>

                        {/* Sort Direction */}
                        <div className="flex items-center justify-between">
                            <span className="text-neutral-200">Direction</span>
                            <div className="flex bg-neutral-800 rounded-lg p-1">
                                <button
                                    className={`px-3 py-1.5 text-sm rounded-md transition-all ${config.sortDirection === SortDirection.Forward ? 'bg-green-600 text-white' : 'text-neutral-400'}`}
                                    onClick={() => updateConfig('sortDirection', SortDirection.Forward)}
                                    title="Forward"
                                >
                                    ▶ Forward
                                </button>
                                <button
                                    className={`px-3 py-1.5 text-sm rounded-md transition-all ${config.sortDirection === SortDirection.Reverse ? 'bg-green-600 text-white' : 'text-neutral-400'}`}
                                    onClick={() => updateConfig('sortDirection', SortDirection.Reverse)}
                                    title="Reverse"
                                >
                                    ◀ Reverse
                                </button>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
};

export default SettingsModal;
