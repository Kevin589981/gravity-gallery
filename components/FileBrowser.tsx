import React, { useState, useEffect } from 'react';
import { Icons } from './Icon';
import { FileSystemEntry, BrowseResponse } from '../types';

interface FileBrowserProps {
  serverUrl: string;
  onPlay: (paths: string[]) => void;
  onCancel: () => void;
}

const FileBrowser: React.FC<FileBrowserProps> = ({ serverUrl, onPlay, onCancel }) => {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileSystemEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  // Helper to normalize URL
  const getApiUrl = (endpoint: string) => {
    const base = serverUrl.endsWith('/') ? serverUrl.slice(0, -1) : serverUrl;
    return `${base}${endpoint}`;
  };

  const fetchDir = async (path: string) => {
    setLoading(true);
    try {
      const url = `${getApiUrl('/api/browse')}?path=${encodeURIComponent(path)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch directory');
      const data: BrowseResponse = await res.json();
      setEntries(data.items);
      setCurrentPath(data.currentPath);
    } catch (e) {
      console.error(e);
      alert("Failed to load folder");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDir('');
  }, []);

  const handleToggleSelect = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSet = new Set(selectedPaths);
    if (newSet.has(path)) {
      newSet.delete(path);
    } else {
      newSet.add(path);
    }
    setSelectedPaths(newSet);
  };

  const handleEntryClick = (entry: FileSystemEntry) => {
    if (entry.type === 'folder') {
      fetchDir(entry.path);
    } else {
        // Toggle selection for individual files if desired, or just ignore
    }
  };

  const handleUpLevel = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    fetchDir(parts.join('/'));
  };

  const handleSelectAllInView = () => {
      const newSet = new Set(selectedPaths);
      entries.forEach(e => {
          if (e.type === 'folder') newSet.add(e.path);
      });
      setSelectedPaths(newSet);
  }

  const handlePlay = () => {
    if (selectedPaths.size === 0 && !currentPath) {
        // If nothing selected, maybe play current folder?
        onPlay([currentPath]);
    } else if (selectedPaths.size === 0) {
        onPlay([currentPath]); 
    } else {
        onPlay(Array.from(selectedPaths));
    }
  };

  return (
    <div className="fixed inset-0 bg-neutral-900 z-50 flex flex-col text-white">
      {/* Header with Safe Area Top */}
      <div className="pt-[calc(1rem_+_env(safe-area-inset-top))] pb-4 px-4 bg-neutral-800 border-b border-neutral-700 flex items-center gap-3 shadow-md z-10 shrink-0">
        <button onClick={onCancel} className="p-2 hover:bg-neutral-700 rounded-full">
          <Icons.Back className="w-6 h-6" />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="font-bold truncate">Server Browser</h2>
          <p className="text-xs text-neutral-400 truncate">/{currentPath}</p>
        </div>
        <button 
          onClick={handlePlay}
          className="bg-blue-600 px-4 py-2 rounded-lg font-bold text-sm shadow-lg active:scale-95 transition-transform"
        >
          Play ({selectedPaths.size || 'All'})
        </button>
      </div>

      {/* Breadcrumb / Up */}
      {currentPath && (
        <button 
          onClick={handleUpLevel}
          className="flex items-center gap-3 p-4 border-b border-neutral-800 hover:bg-neutral-800 transition-colors shrink-0"
        >
          <div className="w-10 h-10 bg-neutral-700 rounded-lg flex items-center justify-center">
            <Icons.Up className="w-6 h-6 text-neutral-400" />
          </div>
          <span className="font-medium text-neutral-300">.. (Up One Level)</span>
        </button>
      )}

      {/* List with Safe Area Bottom */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 pb-[env(safe-area-inset-bottom)]">
        {loading ? (
           <div className="flex justify-center p-10"><Icons.Refresh className="animate-spin text-blue-500" /></div>
        ) : (
            <>
            {entries.length === 0 && <div className="p-8 text-center text-neutral-500">Empty Folder</div>}
            
            {entries.map((entry) => {
              const isSelected = selectedPaths.has(entry.path);
              return (
                <div 
                  key={entry.path}
                  onClick={() => handleEntryClick(entry)}
                  className={`flex items-center gap-3 p-3 rounded-xl transition-all ${entry.type === 'folder' ? 'bg-neutral-800/50 active:bg-neutral-800' : 'opacity-60'}`}
                >
                  {/* Icon */}
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${entry.type === 'folder' ? 'bg-blue-500/20 text-blue-400' : 'bg-neutral-700 text-neutral-500'}`}>
                    {entry.type === 'folder' ? <Icons.Folder className="w-6 h-6" /> : <Icons.File className="w-6 h-6" />}
                  </div>

                  {/* Name */}
                  <div className="flex-1 min-w-0 flex flex-col">
                    <span className="truncate font-medium text-neutral-200">{entry.name}</span>
                  </div>

                  {/* Checkbox (Only for folders for now, to act as playlist source) */}
                  {entry.type === 'folder' && (
                    <button
                      onClick={(e) => handleToggleSelect(entry.path, e)}
                      className={`w-10 h-10 flex items-center justify-center rounded-full border transition-all ${isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-neutral-600 text-transparent hover:border-neutral-400'}`}
                    >
                      <Icons.Check className="w-5 h-5" />
                    </button>
                  )}
                </div>
              );
            })}
            
            <div className="h-20" /> {/* Spacer */}
            </>
        )}
      </div>
      
      {/* Quick Actions */}
      <div className="bg-neutral-800 p-2 pb-[calc(0.5rem_+_env(safe-area-inset-bottom))] flex justify-center text-xs text-neutral-400 border-t border-neutral-700 shrink-0">
          <button onClick={handleSelectAllInView} className="px-4 py-2 hover:text-white">Select All Folders Here</button>
      </div>
    </div>
  );
};

export default FileBrowser;