import React, { useState, useEffect } from 'react';
import { Icons } from './Icon';
import FileBrowser from './FileBrowser';
import { DEFAULT_SERVER_URL } from '../constants';

interface LandingProps {
  onFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onServerConnectAndPlay: (url: string, paths: string[]) => void;
  onLoadDemo: () => void;
  initialServerUrl?: string;
}

const Landing: React.FC<LandingProps> = ({ onFolderSelect, onServerConnectAndPlay, onLoadDemo, initialServerUrl }) => {
  const [serverUrl, setServerUrl] = useState(initialServerUrl || '');
  const [showServerInput, setShowServerInput] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  // Update state if prop changes (e.g. loaded from persistence later)
  useEffect(() => {
    if (initialServerUrl) setServerUrl(initialServerUrl);
  }, [initialServerUrl]);

  // Connection logic just validates URL format and switches UI
  const handleConnectClick = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Use default URL if input is empty, otherwise use input
    let url = serverUrl.trim();
    if (!url) {
        url = DEFAULT_SERVER_URL;
    }

    if (!url.startsWith('http')) url = `http://${url}`;
    
    // Update state to reflect the actual URL being used
    setServerUrl(url);
    setIsConnected(true);
  };

  const handleBrowserPlay = (paths: string[]) => {
      onServerConnectAndPlay(serverUrl, paths);
  };

  if (isConnected) {
      return (
          <FileBrowser 
            serverUrl={serverUrl} 
            onPlay={handleBrowserPlay}
            onCancel={() => setIsConnected(false)}
          />
      );
  }

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6 text-center relative overflow-hidden">
      {/* Background Ambience */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-neutral-800/30 via-black to-black z-0" />
      
      <div className="z-10 max-w-md w-full space-y-8">
        <div className="space-y-2">
           <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl mx-auto flex items-center justify-center shadow-2xl shadow-purple-900/20">
             <Icons.Folder className="w-10 h-10 text-white" />
           </div>
           <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-neutral-400">
             Gravity Gallery
           </h1>
           <p className="text-neutral-400 text-sm">
             Select a local folder on this device, <br/>
             or connect to PC to browse folders.
           </p>
        </div>

        <div className="space-y-4">
          {/* Option 1: Local Folder */}
          <label className="block w-full group cursor-pointer">
            <div className="w-full bg-white text-black font-bold py-4 rounded-xl hover:bg-neutral-200 active:scale-95 transition-all flex items-center justify-center gap-2 shadow-lg shadow-white/10">
              <Icons.Folder className="w-5 h-5" />
              <span>Open Local Folder</span>
            </div>
            <input
              type="file"
              className="hidden"
              // @ts-ignore
              webkitdirectory=""
              directory=""
              multiple
              onChange={onFolderSelect}
            />
          </label>

          {/* Option 2: Server Connect */}
          {!showServerInput ? (
            <button 
              onClick={() => setShowServerInput(true)}
              className="w-full bg-neutral-900 text-white font-medium py-4 rounded-xl border border-neutral-800 hover:border-neutral-700 active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              <Icons.Refresh className="w-5 h-5" />
              <span>Connect to Server</span>
            </button>
          ) : (
            <form onSubmit={handleConnectClick} className="flex gap-2 animate-in fade-in slide-in-from-bottom-2">
              <input 
                type="text"
                placeholder={DEFAULT_SERVER_URL.replace('http://', '')}
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                className="flex-1 bg-neutral-800 border border-neutral-700 text-white px-4 py-3 rounded-xl focus:outline-none focus:border-blue-500 text-sm placeholder-neutral-500"
              />
              <button 
                type="submit"
                className="bg-blue-600 text-white px-4 rounded-xl font-bold hover:bg-blue-500"
              >
                Go
              </button>
            </form>
          )}

          <button 
            onClick={onLoadDemo}
            className="w-full text-xs text-neutral-600 hover:text-neutral-400 py-2"
          >
            Try Demo Images
          </button>
        </div>
      </div>
    </div>
  );
};

export default Landing;