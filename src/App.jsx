import React, { useState, useEffect, useRef } from 'react';

// Helper to format duration
function formatDuration(sec) {
  if (!sec) return '0:00';
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [stats, setStats] = useState({ wanted: 0, snatched: 0, downloading: 0, downloaded: 0, imported: 0, failed: 0, total: 0, librarySize: '0 MB' });
  const [tracks, setTracks] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [settings, setSettings] = useState({
    libraryPath: '',
    autoDownload: true,
    downloadInterval: 5,
    audioFormat: 'mp3',
    audioQuality: '320k',
    navidromeUrl: '',
    navidromeUsername: '',
    navidromePassword: '',
    downloadMethod: 'direct',
    albumDownloadMode: 'single',
    indexerType: 'prowlarr',
    prowlarrUrl: '',
    prowlarrApiKey: '',
    torrentClient: 'qbittorrent',
    torrentClientUrl: '',
    torrentClientUsername: '',
    torrentClientPassword: '',
    downloadPathRemote: '',
    downloadPathLocal: '',
    seedAfterImport: true,
    seedRatioLimit: 0,
    seedTimeLimitHours: 0,
    stallTimeoutMinutes: 30,
    maxTorrentAttempts: 3,
    importMode: 'hardlink',
    deemixUrl: '',
    deemixArl: '',
    deemixPathRemote: '',
    deemixPathLocal: '',
    qualityRules: []
  });
  
  const [settingsTab, setSettingsTab] = useState('general');
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResults, setTestResults] = useState(null);
  
  const [ruleType, setRuleType] = useState('playlist');
  const [ruleName, setRuleName] = useState('');
  const [ruleFormat, setRuleFormat] = useState('mp3');
  const [ruleQuality, setRuleQuality] = useState('320k');
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [addingTrackId, setAddingTrackId] = useState(null);

  // Playlists UI state
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [newPlaylistDesc, setNewPlaylistDesc] = useState('');
  const [showCreatePlaylist, setShowCreatePlaylist] = useState(false);
  const [playlistTrackDropdownId, setPlaylistTrackDropdownId] = useState(null);

  // Batch import state
  const [textImport, setTextImport] = useState('');
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [importLoading, setImportLoading] = useState(false);

  // Queue filter
  const [queueFilter, setQueueFilter] = useState('all');

  // Trigger loading flag for operations
  const [isProcessing, setIsProcessing] = useState(false);

  // Fetch status stats
  const fetchStats = async () => {
    try {
      const res = await fetch('/api/v1/status');
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (e) {
      console.error('Failed to fetch status stats', e);
    }
  };

  // Fetch queue tracks
  const fetchTracks = async () => {
    try {
      const res = await fetch('/api/v1/tracks');
      if (res.ok) {
        const data = await res.json();
        setTracks(data);
      }
    } catch (e) {
      console.error('Failed to fetch queue tracks', e);
    }
  };

  // Fetch playlists
  const fetchPlaylists = async () => {
    try {
      const res = await fetch('/api/v1/playlists');
      if (res.ok) {
        const data = await res.json();
        setPlaylists(data);
        // Refresh active playlist details if one is selected
        if (selectedPlaylist) {
          const updated = data.find(p => p.id === selectedPlaylist.id);
          if (updated) setSelectedPlaylist(updated);
        }
      }
    } catch (e) {
      console.error('Failed to fetch playlists', e);
    }
  };

  // Fetch settings
  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/v1/settings');
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
      }
    } catch (e) {
      console.error('Failed to fetch settings', e);
    }
  };

  // Run on mount and set polling interval
  useEffect(() => {
    fetchStats();
    fetchTracks();
    fetchPlaylists();
    fetchSettings();

    const interval = setInterval(() => {
      fetchStats();
      fetchTracks();
    }, 4000); // Poll status/queue every 4 seconds for immediate updates

    return () => clearInterval(interval);
  }, [selectedPlaylist]);

  // Handle Search submit
  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;

    setSearchLoading(true);
    try {
      const res = await fetch(`/api/v1/search?q=${encodeURIComponent(searchQuery)}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSearchLoading(false);
    }
  };

  // Request song (add to queue)
  const handleRequestTrack = async (track, playlistId = null) => {
    setAddingTrackId(track.id);
    try {
      const res = await fetch('/api/v1/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: track.id,
          title: track.title,
          artists: track.artists || [track.artist],
          album: track.album,
          albumArt: track.albumArt,
          duration: track.duration,
          trackNumber: track.trackNumber || 1,
          releaseDate: track.releaseDate || ''
        })
      });

      if (res.ok) {
        const newTrack = await res.json();
        
        // Add to playlist if playlistId provided
        if (playlistId) {
          await handleAddTrackToPlaylist(playlistId, newTrack.id);
        }

        // Update search results list status inline
        setSearchResults(prev => prev.map(item => {
          if (item.id === track.id) {
            return { ...item, status: 'wanted' };
          }
          return item;
        }));

        fetchTracks();
        fetchStats();
      }
    } catch (err) {
      console.error('Failed to request track', err);
    } finally {
      setAddingTrackId(null);
      setPlaylistTrackDropdownId(null);
    }
  };

  // Trigger background downloads
  const handleTriggerQueue = async () => {
    setIsProcessing(true);
    try {
      const res = await fetch('/api/v1/downloads/trigger', { method: 'POST' });
      if (res.ok) {
        alert('Queue processor kicked off! Check queue status for progress.');
        fetchStats();
        fetchTracks();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsProcessing(false);
    }
  };

  // Clear completed queue items
  const handleClearCompleted = async () => {
    if (!confirm('Clear imported tracks from the queue display list? File downloads remain untouched.')) return;
    try {
      const res = await fetch('/api/v1/tracks/clear', { method: 'POST' });
      if (res.ok) {
        fetchTracks();
        fetchStats();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Delete track from monitor list
  const handleDeleteTrack = async (id) => {
    if (!confirm('Delete track from database monitoring?')) return;
    try {
      const res = await fetch(`/api/v1/tracks/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchTracks();
        fetchStats();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleTestConnections = async () => {
    setTestingConnection(true);
    setTestResults(null);
    try {
      const res = await fetch('/api/v1/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        const data = await res.json();
        setTestResults(data);
      } else {
        alert('Failed to connect to the test endpoint on server.');
      }
    } catch (e) {
      console.error(e);
      alert('Error testing connections.');
    } finally {
      setTestingConnection(false);
    }
  };

  const handleAddRule = (e) => {
    e.preventDefault();
    if (!ruleName.trim()) return;
    
    const newRule = {
      id: 'rule_' + Math.random().toString(36).substr(2, 9),
      type: ruleType,
      name: ruleName.trim(),
      format: ruleFormat,
      quality: ruleQuality
    };
    
    const updatedRules = [...(settings.qualityRules || []), newRule];
    setSettings({ ...settings, qualityRules: updatedRules });
    setRuleName('');
  };

  const handleDeleteRule = (id) => {
    const updatedRules = (settings.qualityRules || []).filter(r => r.id !== id);
    setSettings({ ...settings, qualityRules: updatedRules });
  };

  // Save Settings
  const handleSaveSettings = async (e) => {
    e.preventDefault();
    try {
      // If user typed Navidrome password, compile token
      let token = settings.navidromeToken;
      if (settings.navidromePassword) {
        // Simple client side md5 is hard without libraries, so we generate on server.
        // We'll pass password through and let the server generate.
      }
      
      const res = await fetch('/api/v1/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        alert('Settings saved successfully!');
        fetchSettings();
      } else {
        alert('Failed to save settings.');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Playlist handlers
  const handleCreatePlaylist = async (e) => {
    e.preventDefault();
    if (!newPlaylistName.trim()) return;

    try {
      const res = await fetch('/api/v1/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newPlaylistName, description: newPlaylistDesc })
      });
      if (res.ok) {
        setNewPlaylistName('');
        setNewPlaylistDesc('');
        setShowCreatePlaylist(false);
        fetchPlaylists();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeletePlaylist = async (id) => {
    if (!confirm('Are you sure you want to delete this playlist?')) return;
    try {
      const res = await fetch(`/api/v1/playlists/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setSelectedPlaylist(null);
        fetchPlaylists();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddTrackToPlaylist = async (playlistId, trackId) => {
    try {
      const res = await fetch(`/api/v1/playlists/${playlistId}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId })
      });
      if (res.ok) {
        fetchPlaylists();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemoveTrackFromPlaylist = async (playlistId, trackId) => {
    if (!confirm('Remove track from playlist?')) return;
    try {
      const res = await fetch(`/api/v1/playlists/${playlistId}/tracks/${trackId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        fetchPlaylists();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Batch import handlers
  const handleTextImport = async () => {
    if (!textImport.trim()) return;
    setImportLoading(true);
    setImportStatus('Processing text import in backend...');
    try {
      const res = await fetch('/api/v1/tracks/import-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textImport })
      });
      if (res.ok) {
        setTextImport('');
        setImportStatus('Batch import submitted successfully! Check queue for progress.');
        fetchTracks();
      } else {
        setImportStatus('Failed to start text import.');
      }
    } catch (err) {
      setImportStatus('Error submitting text import: ' + err.message);
    } finally {
      setImportLoading(false);
    }
  };

  const handleSpotifyImport = async () => {
    if (!spotifyUrl.trim()) return;
    setImportLoading(true);
    setImportStatus('Parsing Spotify playlist and matching tracks...');
    try {
      const res = await fetch('/api/v1/tracks/import-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistUrl: spotifyUrl })
      });
      const data = await res.json();
      if (res.ok) {
        setSpotifyUrl('');
        setImportStatus(data.message || 'Import started successfully.');
        fetchTracks();
      } else {
        setImportStatus('Import failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      setImportStatus('Error importing playlist: ' + err.message);
    } finally {
      setImportLoading(false);
    }
  };

  // Filter queue tracks
  const filteredTracks = tracks.filter(t => {
    if (queueFilter === 'all') return true;
    return t.status === queueFilter;
  });

  return (
    <div className="app-container">
      {/* SIDEBAR NAVIGATION */}
      <aside className="sidebar">
        <div className="logo-container">
          <span className="logo-icon">🎵</span>
          <span className="logo-text">SONGARR</span>
        </div>
        
        <nav>
          <ul className="nav-menu">
            <li 
              className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => { setActiveTab('dashboard'); setSelectedPlaylist(null); }}
            >
              <span className="nav-icon">📊</span> Dashboard
            </li>
            <li 
              className={`nav-item ${activeTab === 'search' ? 'active' : ''}`}
              onClick={() => { setActiveTab('search'); setSelectedPlaylist(null); }}
            >
              <span className="nav-icon">🔍</span> Search Tracks
            </li>
            <li 
              className={`nav-item ${activeTab === 'queue' ? 'active' : ''}`}
              onClick={() => { setActiveTab('queue'); setSelectedPlaylist(null); }}
            >
              <span className="nav-icon">⏳</span> Queue / Monitor
            </li>
            <li 
              className={`nav-item ${activeTab === 'playlists' ? 'active' : ''}`}
              onClick={() => { setActiveTab('playlists'); }}
            >
              <span className="nav-icon">🎼</span> Playlists
            </li>
            <li 
              className={`nav-item ${activeTab === 'import' ? 'active' : ''}`}
              onClick={() => { setActiveTab('import'); setSelectedPlaylist(null); }}
            >
              <span className="nav-icon">⚡</span> Batch Import
            </li>
            <li 
              className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => { setActiveTab('settings'); setSelectedPlaylist(null); }}
            >
              <span className="nav-icon">⚙️</span> Settings
            </li>
          </ul>
        </nav>

        <div className="sidebar-footer">
          <div className="status-indicator">
            <div className={`status-dot ${stats.snatched > 0 || stats.downloading > 0 ? 'processing' : ''}`}></div>
            <span>
              {stats.snatched > 0 || stats.downloading > 0 ? 'Processing Queue' : 'System Idle'}
            </span>
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className="main-content">
        
        {/* HEADER BAR */}
        <header className="header-container">
          <div>
            <h1 className="page-title">
              {activeTab === 'dashboard' && 'System Overview'}
              {activeTab === 'search' && 'Search & Discover'}
              {activeTab === 'queue' && 'Acquisition Queue'}
              {activeTab === 'playlists' && (selectedPlaylist ? `Playlist: ${selectedPlaylist.name}` : 'Local Playlists')}
              {activeTab === 'import' && 'Batch Request Importer'}
              {activeTab === 'settings' && 'System Configurations'}
            </h1>
            <p className="page-subtitle">
              {activeTab === 'dashboard' && 'Monitor download queue, disc space, and worker process.'}
              {activeTab === 'search' && 'Find tracks on Deezer catalog and add to library.'}
              {activeTab === 'queue' && 'Review monitored tracks, downloads, and errors.'}
              {activeTab === 'playlists' && (selectedPlaylist ? selectedPlaylist.description || 'Custom playlist details.' : 'Organize tracks into synced Subsonic-compatible M3U files.')}
              {activeTab === 'import' && 'Import Spotify playlists or bulk text tracks into local acquisition.'}
              {activeTab === 'settings' && 'Manage file directories, transcoding formats, and media server details.'}
            </p>
          </div>

          <div className="header-visualizer">
            <span className="visualizer-bar" style={{height: '10px'}}></span>
            <span className="visualizer-bar" style={{height: '20px'}}></span>
            <span className="visualizer-bar" style={{height: '15px'}}></span>
            <span className="visualizer-bar" style={{height: '25px'}}></span>
            <span className="visualizer-bar" style={{height: '12px'}}></span>
          </div>
        </header>

        {/* 1. DASHBOARD VIEW */}
        {activeTab === 'dashboard' && (
          <div>
            <div className="dashboard-grid">
              <div className="stat-card wanted">
                <span className="stat-title">Wanted</span>
                <span className="stat-value">{stats.wanted}</span>
              </div>
              <div className="stat-card downloading">
                <span className="stat-title">Downloading</span>
                <span className="stat-value">{stats.snatched + stats.downloading + stats.downloaded}</span>
              </div>
              <div className="stat-card imported">
                <span className="stat-title">Imported</span>
                <span className="stat-value">{stats.imported}</span>
              </div>
              <div className="stat-card failed">
                <span className="stat-title">Failed</span>
                <span className="stat-value">{stats.failed}</span>
              </div>
              <div className="stat-card" style={{borderLeft: '4px solid #a855f7'}}>
                <span className="stat-title">Library Size</span>
                <span className="stat-value" style={{fontSize: '1.75rem', marginTop: '0.5rem'}}>{stats.librarySize}</span>
              </div>
            </div>

            <div className="panel">
              <h2 className="page-title" style={{fontSize: '1.5rem', marginBottom: '1.5rem'}}>Queue Actions</h2>
              <div style={{display: 'flex', gap: '1rem'}}>
                <button 
                  className="btn btn-primary" 
                  onClick={handleTriggerQueue} 
                  disabled={isProcessing}
                >
                  {isProcessing ? <span className="spinner"></span> : '⚡'} Run Queue Processor Now
                </button>
                <button className="btn btn-secondary" onClick={handleClearCompleted}>
                  🧹 Clear Finished Queue
                </button>
                <button className="btn btn-secondary" onClick={() => setActiveTab('search')}>
                  🔍 Add Music
                </button>
              </div>
            </div>

            <div className="panel">
              <h2 className="page-title" style={{fontSize: '1.5rem', marginBottom: '1.5rem'}}>Recent Activity log</h2>
              <div className="table-container">
                {tracks.length === 0 ? (
                  <div className="no-data">No requested tracks found. Start by searching for a track!</div>
                ) : (
                  <table className="queue-table">
                    <thead>
                      <tr>
                        <th>Track</th>
                        <th>Album</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tracks.slice(-5).reverse().map(track => (
                        <tr key={track.id}>
                          <td>
                            <div className="track-info-cell">
                              <img className="table-art" src={track.albumArt || 'https://via.placeholder.com/150'} alt={track.album} />
                              <div className="track-meta-wrapper">
                                <span className="track-main-title">{track.title}</span>
                                <span className="track-sub-details">{track.artists.join(', ')}</span>
                              </div>
                            </div>
                          </td>
                          <td>{track.album}</td>
                          <td>
                            <span className={`badge badge-${track.status}`}>{track.status}</span>
                            {track.downloadMethod && <span className="method-badge">{track.downloadMethod}</span>}
                            {track.format && <span className="format-badge">{track.format.toUpperCase()}</span>}
                            {track.error && <div className="error-msg" title={track.error}>{track.error}</div>}
                          </td>
                          <td>
                            <button className="btn btn-danger" style={{padding: '0.4rem 0.8rem'}} onClick={() => handleDeleteTrack(track.id)}>
                              🗑️
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 2. SEARCH VIEW */}
        {activeTab === 'search' && (
          <div>
            <div className="panel">
              <form onSubmit={handleSearch} className="search-bar-container">
                <div className="search-input-wrapper">
                  <span className="search-icon">🔍</span>
                  <input 
                    type="text" 
                    className="input-text" 
                    placeholder="Search by song name, artist, album, or ISRC..." 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <button type="submit" className="btn btn-primary" disabled={searchLoading}>
                  {searchLoading ? <span className="spinner"></span> : 'Search'}
                </button>
              </form>
            </div>

            {searchLoading ? (
              <span className="spinner spinner-large"></span>
            ) : (
              <div className="results-grid">
                {searchResults.map(track => (
                  <div key={track.id} className="track-card">
                    <div className="album-art-wrapper">
                      <img className="album-art" src={track.albumArt || 'https://via.placeholder.com/150'} alt={track.album} />
                    </div>
                    <div className="track-card-content">
                      <h3 className="track-title" title={track.title}>{track.title}</h3>
                      <p className="track-artist" title={track.artist}>{track.artist}</p>
                      <p className="track-album" title={track.album}>{track.album}</p>
                      
                      <div className="track-footer">
                        <span className="track-duration">{formatDuration(track.duration)}</span>
                        
                        <div style={{display: 'flex', gap: '0.5rem', alignItems: 'center'}}>
                          {track.status !== 'none' ? (
                            <span className={`badge badge-${track.status}`}>{track.status}</span>
                          ) : (
                            <>
                              <button 
                                className="btn btn-primary"
                                style={{padding: '0.4rem 0.8rem', fontSize: '0.8rem'}}
                                onClick={() => handleRequestTrack(track)}
                                disabled={addingTrackId === track.id}
                              >
                                {addingTrackId === track.id ? <span className="spinner"></span> : '+ Request'}
                              </button>
                              
                              {/* Playlist dropdown selector */}
                              <div style={{position: 'relative'}}>
                                <button 
                                  className="btn btn-secondary" 
                                  style={{padding: '0.4rem 0.6rem', fontSize: '0.8rem'}}
                                  onClick={() => setPlaylistTrackDropdownId(playlistTrackDropdownId === track.id ? null : track.id)}
                                >
                                  📂
                                </button>
                                
                                {playlistTrackDropdownId === track.id && (
                                  <div style={{
                                    position: 'absolute', right: 0, bottom: '100%', marginBottom: '8px', 
                                    backgroundColor: '#121420', border: '1px solid var(--border-color)', 
                                    borderRadius: '8px', padding: '0.5rem', width: '200px', zIndex: 50,
                                    boxShadow: '0 5px 15px rgba(0,0,0,0.5)'
                                  }}>
                                    <p style={{fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: '0.5rem'}}>Add to Playlist & Queue:</p>
                                    {playlists.length === 0 ? (
                                      <p style={{fontSize: '0.8rem', color: 'var(--color-text-muted)'}}>No playlists created.</p>
                                    ) : (
                                      playlists.map(pl => (
                                        <button 
                                          key={pl.id} 
                                          className="btn btn-secondary"
                                          style={{
                                            width: '100%', justifyContent: 'flex-start', padding: '0.4rem', 
                                            fontSize: '0.8rem', marginBottom: '4px', textOverflow: 'ellipsis', 
                                            overflow: 'hidden', whiteSpace: 'nowrap'
                                          }}
                                          onClick={() => handleRequestTrack(track, pl.id)}
                                        >
                                          📁 {pl.name}
                                        </button>
                                      ))
                                    )}
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 3. QUEUE VIEW */}
        {activeTab === 'queue' && (
          <div className="panel">
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem'}}>
              <div style={{display: 'flex', gap: '0.5rem'}}>
                {['all', 'wanted', 'snatched', 'downloading', 'downloaded', 'imported', 'failed'].map(filter => (
                  <button 
                    key={filter} 
                    className={`btn ${queueFilter === filter ? 'btn-primary' : 'btn-secondary'}`}
                    style={{padding: '0.4rem 0.8rem', fontSize: '0.85rem', textTransform: 'capitalize'}}
                    onClick={() => setQueueFilter(filter)}
                  >
                    {filter}
                  </button>
                ))}
              </div>
              <button className="btn btn-secondary" onClick={fetchTracks}>
                🔄 Refresh
              </button>
            </div>

            <div className="table-container">
              {filteredTracks.length === 0 ? (
                <div className="no-data">No songs in queue matching the filter.</div>
              ) : (
                <table className="queue-table">
                  <thead>
                    <tr>
                      <th>Track</th>
                      <th>Album</th>
                      <th>Duration</th>
                      <th>Status</th>
                      <th>Requested At</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTracks.slice().reverse().map(track => (
                      <tr key={track.id}>
                        <td>
                          <div className="track-info-cell">
                            <img className="table-art" src={track.albumArt || 'https://via.placeholder.com/150'} alt={track.album} />
                            <div className="track-meta-wrapper">
                              <span className="track-main-title">{track.title}</span>
                              <span className="track-sub-details">{track.artists.join(', ')}</span>
                            </div>
                          </div>
                        </td>
                        <td>{track.album}</td>
                        <td>{formatDuration(track.duration)}</td>
                        <td>
                          <span className={`badge badge-${track.status}`}>{track.status}</span>
                          {track.downloadMethod && <span className="method-badge">{track.downloadMethod}</span>}
                          {track.format && <span className="format-badge">{track.format.toUpperCase()}</span>}
                          {track.error && <div className="error-msg" title={track.error}>{track.error}</div>}
                          {track.filePath && (
                            <div style={{fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '0.25rem', wordBreak: 'break-all'}}>
                              📂 {track.filePath}
                            </div>
                          )}
                        </td>
                        <td>{new Date(track.createdAt).toLocaleString()}</td>
                        <td>
                          <button className="btn btn-danger" style={{padding: '0.4rem 0.8rem'}} onClick={() => handleDeleteTrack(track.id)}>
                            🗑️ Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* 4. PLAYLISTS VIEW */}
        {activeTab === 'playlists' && (
          <div>
            {!selectedPlaylist ? (
              // List Playlists
              <div>
                <div className="panel" style={{marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                  <h2 style={{fontSize: '1.5rem', fontFamily: 'var(--font-family-heading)'}}>All Playlists</h2>
                  <button className="btn btn-primary" onClick={() => setShowCreatePlaylist(!showCreatePlaylist)}>
                    {showCreatePlaylist ? 'Cancel' : '+ Create Playlist'}
                  </button>
                </div>

                {showCreatePlaylist && (
                  <form onSubmit={handleCreatePlaylist} className="panel" style={{marginBottom: '2rem'}}>
                    <h3 style={{fontSize: '1.2rem', marginBottom: '1rem', fontFamily: 'var(--font-family-heading)'}}>New Playlist Details</h3>
                    <div className="form-group">
                      <label className="form-label">Playlist Name</label>
                      <input 
                        type="text" 
                        className="input-text" 
                        required 
                        placeholder="e.g. Summer Road Trip"
                        value={newPlaylistName}
                        onChange={e => setNewPlaylistName(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Description (Optional)</label>
                      <input 
                        type="text" 
                        className="input-text" 
                        placeholder="e.g. Bangers for the highway"
                        value={newPlaylistDesc}
                        onChange={e => setNewPlaylistDesc(e.target.value)}
                      />
                    </div>
                    <button type="submit" className="btn btn-primary">Create Playlist</button>
                  </form>
                )}

                <div className="playlists-grid">
                  {playlists.map(pl => (
                    <div key={pl.id} className="playlist-card" onClick={() => setSelectedPlaylist(pl)}>
                      <h3 className="playlist-name">📁 {pl.name}</h3>
                      <p className="playlist-desc">{pl.description || 'No description'}</p>
                      <span className="playlist-count">{pl.tracks?.length || 0} Tracks</span>
                    </div>
                  ))}
                  {playlists.length === 0 && (
                    <div className="no-data" style={{gridColumn: '1/-1'}}>No playlists created yet. Set one up to group your downloaded tracks.</div>
                  )}
                </div>
              </div>
            ) : (
              // Detailed Playlist View
              <div>
                <div className="panel" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem'}}>
                  <div>
                    <button className="btn btn-secondary" style={{marginBottom: '1rem'}} onClick={() => setSelectedPlaylist(null)}>
                      ⬅ Back to Playlists
                    </button>
                    <h2 className="page-title">{selectedPlaylist.name}</h2>
                    <p style={{color: 'var(--color-text-secondary)', fontSize: '0.9rem'}}>{selectedPlaylist.description || 'No description'}</p>
                    <p style={{fontSize: '0.8rem', color: 'var(--color-text-muted)', marginTop: '0.5rem'}}>
                      📢 Navidrome-compatible M3U generated at: <code>{settings.libraryPath}/Playlists/{selectedPlaylist.name.replace(/[\\/:*?"<>|]/g, '_')}.m3u</code>
                    </p>
                  </div>
                  <button className="btn btn-danger" onClick={() => handleDeletePlaylist(selectedPlaylist.id)}>
                    🗑️ Delete Playlist
                  </button>
                </div>

                <div className="panel">
                  <h3 style={{fontSize: '1.25rem', marginBottom: '1rem', fontFamily: 'var(--font-family-heading)'}}>Playlist Tracks</h3>
                  <div className="table-container">
                    {!selectedPlaylist.tracks || selectedPlaylist.tracks.length === 0 ? (
                      <div className="no-data">This playlist has no tracks. Search for tracks to add them here!</div>
                    ) : (
                      <table className="queue-table">
                        <thead>
                          <tr>
                            <th>Track</th>
                            <th>Album</th>
                            <th>Status</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedPlaylist.tracks.map(track => (
                            <tr key={track.id}>
                              <td>
                                <div className="track-info-cell">
                                  <img className="table-art" src={track.albumArt || 'https://via.placeholder.com/150'} alt={track.album} />
                                  <div className="track-meta-wrapper">
                                    <span className="track-main-title">{track.title}</span>
                                    <span className="track-sub-details">{track.artists.join(', ')}</span>
                                  </div>
                                </div>
                              </td>
                              <td>{track.album}</td>
                              <td>
                                <span className={`badge badge-${track.status}`}>{track.status}</span>
                              </td>
                              <td>
                                <button 
                                  className="btn btn-danger" 
                                  style={{padding: '0.4rem 0.8rem'}}
                                  onClick={() => handleRemoveTrackFromPlaylist(selectedPlaylist.id, track.id)}
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 5. BATCH IMPORT VIEW */}
        {activeTab === 'import' && (
          <div className="settings-grid">
            {/* Spotify Importer */}
            <div className="panel">
              <h2 className="page-title" style={{fontSize: '1.5rem', marginBottom: '1.5rem'}}>Spotify Playlist Sync</h2>
              <p style={{color: 'var(--color-text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem'}}>
                Paste the URL of any public Spotify playlist. Songarr will parse the playlist embed and search the Deezer catalog for match matching metadata, importing found tracks into the queue.
              </p>
              
              <div className="form-group">
                <label className="form-label">Spotify Playlist URL</label>
                <input 
                  type="text" 
                  className="input-text" 
                  placeholder="https://open.spotify.com/playlist/37i9dQZF1DXcBWIG3mqhfw"
                  value={spotifyUrl}
                  onChange={e => setSpotifyUrl(e.target.value)}
                />
              </div>

              <button 
                className="btn btn-primary" 
                onClick={handleSpotifyImport}
                disabled={importLoading || !spotifyUrl.trim()}
              >
                {importLoading ? <span className="spinner"></span> : '⚡'} Start Spotify Import
              </button>
            </div>

            {/* Plain Text Importer */}
            <div className="panel">
              <h2 className="page-title" style={{fontSize: '1.5rem', marginBottom: '1.5rem'}}>Plain Text Batch Request</h2>
              <p style={{color: 'var(--color-text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem'}}>
                Request multiple songs at once. Enter one song per line (e.g. <code>Artist - Track Title</code>). Songarr will search and snatch the best result for each line.
              </p>
              
              <div className="form-group">
                <label className="form-label">Songs List (One per line)</label>
                <textarea 
                  className="input-text" 
                  style={{minHeight: '120px', resize: 'vertical'}}
                  placeholder="M83 - Midnight City&#10;Daft Punk - One More Time&#10;The Weeknd - Blinding Lights"
                  value={textImport}
                  onChange={e => setTextImport(e.target.value)}
                />
              </div>

              <button 
                className="btn btn-primary" 
                onClick={handleTextImport}
                disabled={importLoading || !textImport.trim()}
              >
                {importLoading ? <span className="spinner"></span> : '⚡'} Start Batch Import
              </button>
            </div>

            {importStatus && (
              <div className="panel" style={{gridColumn: '1/-1', borderLeft: '4px solid var(--border-focus)'}}>
                <h3 style={{fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem'}}>Import Console</h3>
                <pre style={{whiteSpace: 'pre-wrap', fontSize: '0.9rem', color: 'var(--color-text-secondary)'}}>{importStatus}</pre>
              </div>
            )}
          </div>
        )}

        {/* 6. SETTINGS VIEW */}
        {activeTab === 'settings' && (
          <div className="panel">
            {/* Settings Tab Headers */}
            <div className="settings-tabs">
              <button 
                type="button"
                className={`settings-tab-btn ${settingsTab === 'general' ? 'active' : ''}`}
                onClick={() => setSettingsTab('general')}
              >
                ⚙️ General & Media Server
              </button>
              <button 
                type="button"
                className={`settings-tab-btn ${settingsTab === 'connectors' ? 'active' : ''}`}
                onClick={() => setSettingsTab('connectors')}
              >
                🔌 Indexers & Downloaders
              </button>
              <button 
                type="button"
                className={`settings-tab-btn ${settingsTab === 'overrides' ? 'active' : ''}`}
                onClick={() => setSettingsTab('overrides')}
              >
                🎛️ Quality Overrides
              </button>
            </div>

            <form onSubmit={handleSaveSettings}>
              {/* TAB 1: GENERAL & MEDIA SERVER */}
              {settingsTab === 'general' && (
                <div className="settings-grid">
                  {/* Left Column: Acquisition Directories and Formats */}
                  <div>
                    <h3 style={{fontSize: '1.25rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', fontFamily: 'var(--font-family-heading)'}}>
                      Library & Format Defaults
                    </h3>
                    
                    <div className="form-group">
                      <label className="form-label">Music Library Destination Path</label>
                      <input 
                        type="text" 
                        className="input-text" 
                        required 
                        value={settings.libraryPath}
                        onChange={e => setSettings({...settings, libraryPath: e.target.value})}
                      />
                      <span className="form-help">Where imported track files are organized.</span>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Audio Format</label>
                      <select 
                        className="select-custom"
                        value={settings.audioFormat}
                        onChange={e => setSettings({...settings, audioFormat: e.target.value})}
                      >
                        <option value="mp3">MP3 (.mp3)</option>
                        <option value="m4a">M4A / AAC (.m4a)</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Target Bitrate Quality</label>
                      <select 
                        className="select-custom"
                        value={settings.audioQuality}
                        onChange={e => setSettings({...settings, audioQuality: e.target.value})}
                      >
                        <option value="320k">320kbps (High Lossy)</option>
                        <option value="256k">256kbps (Standard Streaming)</option>
                        <option value="192k">192kbps (Medium)</option>
                        <option value="128k">128kbps (Low Space)</option>
                      </select>
                    </div>

                    <div className="form-group" style={{flexDirection: 'row', alignItems: 'center', gap: '1rem', marginTop: '1rem'}}>
                      <input 
                        type="checkbox" 
                        id="autoDownload"
                        checked={settings.autoDownload}
                        onChange={e => setSettings({...settings, autoDownload: e.target.checked})}
                        style={{width: '20px', height: '20px'}}
                      />
                      <div>
                        <label className="form-label" htmlFor="autoDownload" style={{cursor: 'pointer'}}>Enable Background Worker</label>
                        <span className="form-help" style={{display: 'block'}}>Process queue automatically in the background.</span>
                      </div>
                    </div>

                    {settings.autoDownload && (
                      <div className="form-group" style={{marginTop: '1rem'}}>
                        <label className="form-label">Check Queue Interval (Minutes)</label>
                        <input 
                          type="number" 
                          className="input-text" 
                          min="1"
                          value={settings.downloadInterval}
                          onChange={e => setSettings({...settings, downloadInterval: parseInt(e.target.value) || 5})}
                        />
                      </div>
                    )}
                  </div>

                  {/* Right Column: Navidrome Integration */}
                  <div>
                    <h3 style={{fontSize: '1.25rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', fontFamily: 'var(--font-family-heading)'}}>
                      Navidrome Media Server Integration
                    </h3>
                    <p style={{color: 'var(--color-text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem'}}>
                      Trigger automatic scans in Navidrome when new songs are downloaded. Uses the standard Subsonic API.
                    </p>

                    <div className="form-group">
                      <label className="form-label">Navidrome / Subsonic Server URL</label>
                      <input 
                        type="url" 
                        className="input-text" 
                        placeholder="e.g. http://192.168.1.100:4533"
                        value={settings.navidromeUrl}
                        onChange={e => setSettings({...settings, navidromeUrl: e.target.value})}
                      />
                      <span className="form-help">The external address of your Navidrome media server.</span>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Navidrome Username</label>
                      <input 
                        type="text" 
                        className="input-text" 
                        placeholder="admin"
                        value={settings.navidromeUsername}
                        onChange={e => setSettings({...settings, navidromeUsername: e.target.value})}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Navidrome Password / Subsonic Token</label>
                      <input 
                        type="password" 
                        className="input-text" 
                        placeholder="••••••••••••••"
                        value={settings.navidromePassword}
                        onChange={e => setSettings({...settings, navidromePassword: e.target.value})}
                      />
                      <span className="form-help">Your password. Used to verify connection, passwords are encrypted locally.</span>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: CONNECTORS (INDEXERS & DOWNLOADERS) */}
              {settingsTab === 'connectors' && (
                <div className="settings-grid">
                  {/* Left Column: Acquisition Mode and Indexer Configuration */}
                  <div>
                    <h3 style={{fontSize: '1.25rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', fontFamily: 'var(--font-family-heading)'}}>
                      Acquisition Method Settings
                    </h3>
                    
                    <div className="form-group">
                      <label className="form-label">Download Mode</label>
                      <select 
                        className="select-custom"
                        value={settings.downloadMethod}
                        onChange={e => setSettings({...settings, downloadMethod: e.target.value})}
                      >
                        <option value="direct">Direct Download (YouTube Music / yt-dlp)</option>
                        <option value="torrent">Torrent / Usenet search (Prowlarr/Jackett)</option>
                      </select>
                      <span className="form-help">Choose between YouTube scraping or full lossless Torrent/Usenet indexes.</span>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Album Post-Processing Mode</label>
                      <select 
                        className="select-custom"
                        value={settings.albumDownloadMode}
                        onChange={e => setSettings({...settings, albumDownloadMode: e.target.value})}
                      >
                        <option value="single">Extract Single Track (import only the requested song)</option>
                        <option value="album">Keep Entire Album (Save all torrent audio files)</option>
                      </select>
                      <span className="form-help">Controls folder behavior when snatching multi-file releases.</span>
                    </div>

                    <div style={{marginTop: '2rem'}}>
                      <h4 style={{fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'var(--font-family-heading)'}}>deemix (Deezer, tried first)</h4>

                      <div className="form-group">
                        <label className="form-label">deemix URL (blank = off)</label>
                        <input
                          type="url"
                          className="input-text"
                          placeholder="e.g. http://deemix:6595"
                          value={settings.deemixUrl}
                          onChange={e => setSettings({...settings, deemixUrl: e.target.value})}
                        />
                        <span className="form-help">Downloads the exact Deezer track (FLAC when the format is FLAC, else MP3 320). If deemix fails, the mode above takes over.</span>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Deezer ARL (optional)</label>
                        <input
                          type="password"
                          className="input-text"
                          placeholder="Blank: use the login saved in deemix"
                          value={settings.deemixArl}
                          onChange={e => setSettings({...settings, deemixArl: e.target.value})}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">deemix Path Mapping (optional)</label>
                        <input
                          type="text"
                          className="input-text"
                          placeholder="deemix path, e.g. /downloads"
                          value={settings.deemixPathRemote}
                          onChange={e => setSettings({...settings, deemixPathRemote: e.target.value})}
                        />
                        <input
                          type="text"
                          className="input-text"
                          style={{marginTop: '0.5rem'}}
                          placeholder="Same folder as Songarr sees it"
                          value={settings.deemixPathLocal}
                          onChange={e => setSettings({...settings, deemixPathLocal: e.target.value})}
                        />
                        <span className="form-help">Files are moved from deemix's download folder into the library, so it must be mounted in Songarr too.</span>
                      </div>

                      {settings.deemixUrl && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{width: '100%', padding: '0.8rem'}}
                          onClick={handleTestConnections}
                          disabled={testingConnection}
                        >
                          {testingConnection ? <span className="spinner"></span> : '🔍'} Test deemix
                        </button>
                      )}
                      {testResults?.deemix && settings.deemixUrl && (
                        <p style={{fontSize: '0.75rem', marginTop: '0.5rem'}} className={testResults.deemix.success ? 'test-result-success' : 'test-result-failed'}>
                          {testResults.deemix.message}
                        </p>
                      )}
                    </div>

                    {settings.downloadMethod === 'torrent' && (
                      <div style={{marginTop: '2rem'}}>
                        <h4 style={{fontSize: '1.1rem', marginBottom: '1rem', fontFamily: 'var(--font-family-heading)'}}>Indexer Integration</h4>
                        
                        <div className="form-group">
                          <label className="form-label">Indexer Manager Type</label>
                          <select 
                            className="select-custom"
                            value={settings.indexerType}
                            onChange={e => setSettings({...settings, indexerType: e.target.value})}
                          >
                            <option value="prowlarr">Prowlarr</option>
                            <option value="jackett">Jackett</option>
                          </select>
                        </div>

                        <div className="form-group">
                          <label className="form-label">Indexer API / Web Address URL</label>
                          <input 
                            type="url" 
                            className="input-text" 
                            placeholder="e.g. http://localhost:9696"
                            value={settings.prowlarrUrl}
                            onChange={e => setSettings({...settings, prowlarrUrl: e.target.value})}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">Indexer API Key</label>
                          <input 
                            type="password" 
                            className="input-text" 
                            placeholder="API Key string..."
                            value={settings.prowlarrApiKey}
                            onChange={e => setSettings({...settings, prowlarrApiKey: e.target.value})}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Right Column: Download Client Credentials */}
                  <div>
                    {settings.downloadMethod === 'torrent' && (
                      <div>
                        <h3 style={{fontSize: '1.25rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', fontFamily: 'var(--font-family-heading)'}}>
                          Download Client Integration
                        </h3>
                        
                        <div className="form-group">
                          <label className="form-label">Download Client Type</label>
                          <select 
                            className="select-custom"
                            value={settings.torrentClient}
                            onChange={e => setSettings({...settings, torrentClient: e.target.value})}
                          >
                            <option value="qbittorrent">qBittorrent</option>
                            <option value="deluge">Deluge</option>
                            <option value="transmission">Transmission</option>
                            <option value="sabnzbd">SABnzbd (NZB / Usenet)</option>
                          </select>
                        </div>

                        <div className="form-group">
                          <label className="form-label">Client Connection URL</label>
                          <input 
                            type="url" 
                            className="input-text" 
                            placeholder="e.g. http://localhost:8080"
                            value={settings.torrentClientUrl}
                            onChange={e => setSettings({...settings, torrentClientUrl: e.target.value})}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">Username (Not needed for Deluge)</label>
                          <input 
                            type="text" 
                            className="input-text" 
                            value={settings.torrentClientUsername}
                            onChange={e => setSettings({...settings, torrentClientUsername: e.target.value})}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">Password / WebUI Secret key</label>
                          <input 
                            type="password" 
                            className="input-text" 
                            placeholder="••••••••••••••"
                            value={settings.torrentClientPassword}
                            onChange={e => setSettings({...settings, torrentClientPassword: e.target.value})}
                          />
                          <span className="form-help">Enter the password or api key of your selected downloader client.</span>
                        </div>

                        <div className="form-group">
                          <label className="form-label">Remote Path Mapping (optional)</label>
                          <input 
                            type="text" 
                            className="input-text" 
                            placeholder="Client path, e.g. /downloads"
                            value={settings.downloadPathRemote}
                            onChange={e => setSettings({...settings, downloadPathRemote: e.target.value})}
                          />
                          <input 
                            type="text" 
                            className="input-text" 
                            style={{marginTop: '0.5rem'}}
                            placeholder="Same folder as Songarr sees it, e.g. /storage/downloads"
                            value={settings.downloadPathLocal}
                            onChange={e => setSettings({...settings, downloadPathLocal: e.target.value})}
                          />
                          <span className="form-help">Only needed when the download client reports paths Songarr can't see directly (different containers or hosts).</span>
                        </div>

                        <div className="form-group" style={{flexDirection: 'row', alignItems: 'center', gap: '1rem'}}>
                          <input 
                            type="checkbox" 
                            id="seedAfterImport"
                            checked={settings.seedAfterImport}
                            onChange={e => setSettings({...settings, seedAfterImport: e.target.checked})}
                            style={{width: '20px', height: '20px'}}
                          />
                          <div>
                            <label className="form-label" htmlFor="seedAfterImport" style={{cursor: 'pointer'}}>Keep Seeding After Import</label>
                            <span className="form-help" style={{display: 'block'}}>Leave the torrent in the client. Off: remove it and its download files as soon as the track is imported. (Usenet jobs are always removed.)</span>
                          </div>
                        </div>

                        {settings.seedAfterImport && (
                          <div className="form-group">
                            <label className="form-label">Stop Seeding At (0 = never)</label>
                            <div style={{display: 'flex', gap: '0.5rem'}}>
                              <input 
                                type="number" 
                                min="0" 
                                step="0.1" 
                                className="input-text" 
                                placeholder="Ratio"
                                value={settings.seedRatioLimit}
                                onChange={e => setSettings({...settings, seedRatioLimit: Number(e.target.value)})}
                              />
                              <input 
                                type="number" 
                                min="0" 
                                step="1" 
                                className="input-text" 
                                placeholder="Hours"
                                value={settings.seedTimeLimitHours}
                                onChange={e => setSettings({...settings, seedTimeLimitHours: Number(e.target.value)})}
                              />
                            </div>
                            <span className="form-help">Ratio, then hours seeded. Whichever is reached first removes the torrent and its download files; the library copy stays.</span>
                          </div>
                        )}

                        <div className="form-group">
                          <label className="form-label">Dead Torrents (minutes without progress, attempts)</label>
                          <div style={{display: 'flex', gap: '0.5rem'}}>
                            <input 
                              type="number" 
                              min="0" 
                              step="5" 
                              className="input-text" 
                              placeholder="Minutes"
                              value={settings.stallTimeoutMinutes}
                              onChange={e => setSettings({...settings, stallTimeoutMinutes: Number(e.target.value)})}
                            />
                            <input 
                              type="number" 
                              min="1" 
                              step="1" 
                              className="input-text" 
                              placeholder="Attempts"
                              value={settings.maxTorrentAttempts}
                              onChange={e => setSettings({...settings, maxTorrentAttempts: Number(e.target.value)})}
                            />
                          </div>
                          <span className="form-help">A torrent with no progress for this long is removed and the next-best release tried; after this many dead ones, YouTube. 0 minutes = wait forever.</span>
                        </div>

                        <div className="form-group">
                          <label className="form-label">Import Method</label>
                          <select 
                            className="select-custom"
                            value={settings.importMode}
                            onChange={e => setSettings({...settings, importMode: e.target.value})}
                          >
                            <option value="hardlink">Hardlink (no extra space; falls back to copy)</option>
                            <option value="copy">Copy</option>
                          </select>
                          <span className="form-help">Hardlinks need the downloads and library on the same filesystem. MP3s are always copied, because tagging them would alter the data being seeded.</span>
                        </div>

                        <button 
                          type="button" 
                          className="btn btn-secondary" 
                          style={{width: '100%', marginTop: '1rem', padding: '0.8rem'}}
                          onClick={handleTestConnections}
                          disabled={testingConnection}
                        >
                          {testingConnection ? <span className="spinner"></span> : '🔍'} Test Connections
                        </button>

                        {testResults && (
                          <div className="test-panel">
                            <h4 style={{fontSize: '0.9rem', marginBottom: '0.5rem', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '0.25rem'}}>Connection Test Summary:</h4>
                            <div className="test-result-item">
                              <span>Indexer Connection:</span>
                              <span className={testResults.indexer.success ? 'test-result-success' : 'test-result-failed'}>
                                {testResults.indexer.success ? 'SUCCESS' : 'FAILED'}
                              </span>
                            </div>
                            <p style={{fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '0.75rem'}}>
                              {testResults.indexer.message}
                            </p>
                            
                            <div className="test-result-item">
                              <span>Downloader Client:</span>
                              <span className={testResults.downloadClient.success ? 'test-result-success' : 'test-result-failed'}>
                                {testResults.downloadClient.success ? 'SUCCESS' : 'FAILED'}
                              </span>
                            </div>
                            <p style={{fontSize: '0.75rem', color: 'var(--color-text-muted)'}}>
                              {testResults.downloadClient.message}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                    
                    {settings.downloadMethod === 'direct' && (
                      <div style={{padding: '2rem', textAlign: 'center', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-lg)'}}>
                        <p style={{fontSize: '3rem'}}>🎵</p>
                        <h4 style={{marginBottom: '0.5rem', fontFamily: 'var(--font-family-heading)'}}>Direct Download Mode Active</h4>
                        <p style={{fontSize: '0.85rem', color: 'var(--color-text-secondary)'}}>
                          All queue items will search YouTube for standard audio recordings. No Prowlarr indexers or local BitTorrent clients are utilized in this configuration.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 3: QUALITY OVERRIDES */}
              {settingsTab === 'overrides' && (
                <div>
                  <h3 style={{fontSize: '1.25rem', marginBottom: '0.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', fontFamily: 'var(--font-family-heading)'}}>
                    Quality & Format Overrides
                  </h3>
                  <p style={{color: 'var(--color-text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem'}}>
                    Configure specific artists or playlists to target higher quality codecs (like FLAC lossless) or lower bitrates, overriding the global defaults.
                  </p>

                  {/* Add New Override Rule Form */}
                  <div className="rules-form-inline">
                    <div className="form-group" style={{flex: 1, marginBottom: 0}}>
                      <label className="form-label">Override Type</label>
                      <select 
                        className="select-custom" 
                        value={ruleType}
                        onChange={e => setRuleType(e.target.value)}
                      >
                        <option value="artist">Artist Name</option>
                        <option value="playlist">Playlist Name</option>
                      </select>
                    </div>

                    <div className="form-group" style={{flex: 2, marginBottom: 0}}>
                      <label className="form-label">Target Name (Match string)</label>
                      <input 
                        type="text" 
                        className="input-text" 
                        placeholder="e.g. Daft Punk" 
                        value={ruleName}
                        onChange={e => setRuleName(e.target.value)}
                      />
                    </div>

                    <div className="form-group" style={{flex: 1, marginBottom: 0}}>
                      <label className="form-label">Override Format</label>
                      <select 
                        className="select-custom" 
                        value={ruleFormat}
                        onChange={e => setRuleFormat(e.target.value)}
                      >
                        <option value="mp3">MP3</option>
                        <option value="flac">FLAC (Lossless)</option>
                      </select>
                    </div>

                    <div className="form-group" style={{flex: 1, marginBottom: 0}}>
                      <label className="form-label">Override Quality</label>
                      <select 
                        className="select-custom" 
                        value={ruleQuality}
                        onChange={e => setRuleQuality(e.target.value)}
                      >
                        <option value="320k">320kbps (High)</option>
                        <option value="lossless">Lossless (FLAC Only)</option>
                      </select>
                    </div>

                    <button 
                      type="button" 
                      className="btn btn-primary" 
                      style={{padding: '0.75rem 1.25rem', whiteSpace: 'nowrap'}}
                      onClick={handleAddRule}
                    >
                      ➕ Add Rule
                    </button>
                  </div>

                  {/* Active Rules List */}
                  {(settings.qualityRules || []).length === 0 ? (
                    <div className="no-data">No active override rules defined. Global defaults will apply.</div>
                  ) : (
                    <table className="rules-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Target Match Name</th>
                          <th>Codec Format</th>
                          <th>Target Quality</th>
                          <th style={{textAlign: 'right'}}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(settings.qualityRules || []).map(rule => (
                          <tr key={rule.id}>
                            <td style={{textTransform: 'capitalize', fontWeight: '600'}}>{rule.type}</td>
                            <td>{rule.name}</td>
                            <td style={{textTransform: 'uppercase'}}>{rule.format}</td>
                            <td>{rule.quality === 'lossless' ? 'Lossless' : rule.quality}</td>
                            <td style={{textAlign: 'right'}}>
                              <button 
                                type="button" 
                                className="btn btn-danger" 
                                style={{padding: '0.4rem 0.8rem'}}
                                onClick={() => handleDeleteRule(rule.id)}
                              >
                                🗑️ Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              <div style={{marginTop: '2rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem'}}>
                <button type="submit" className="btn btn-primary">Save Configurations</button>
              </div>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
