import { useState } from 'react';
import './index.css';

function App() {
  const [activeTab, setActiveTab] = useState<'search' | 'upload'>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = async () => {
    if (!searchQuery) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      alert('Search failed');
    }
    setIsLoading(false);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source', 'MANUAL_UPLOAD');
    
    setIsLoading(true);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        alert('File uploaded and import started!');
      } else {
        alert('Upload failed.');
      }
    } catch (err) {
      console.error(err);
      alert('Upload failed.');
    }
    setIsLoading(false);
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>Sanctions Intelligence</h1>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button 
            style={{ 
              background: activeTab === 'search' ? 'var(--primary)' : 'var(--surface)',
              color: activeTab === 'search' ? 'white' : 'var(--text-muted)',
              border: '1px solid var(--border)'
            }}
            onClick={() => setActiveTab('search')}
          >
            Search
          </button>
          <button 
            style={{ 
              background: activeTab === 'upload' ? 'var(--primary)' : 'var(--surface)',
              color: activeTab === 'upload' ? 'white' : 'var(--text-muted)',
              border: '1px solid var(--border)'
            }}
            onClick={() => setActiveTab('upload')}
          >
            Upload Lists
          </button>
        </div>
      </header>

      {activeTab === 'search' ? (
        <div className="card">
          <h2 style={{ marginBottom: '1rem' }}>Search Entities</h2>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <input 
              type="text" 
              placeholder="Search by name, passport, or ID..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <button onClick={handleSearch} disabled={isLoading}>
              {isLoading ? 'Searching...' : 'Search'}
            </button>
          </div>
          
          <div className="results-grid">
            {results.map((r, i) => (
              <div key={i} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                  <span className="tag">{r.source}</span>
                  <span className="tag" style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }}>{r.type}</span>
                </div>
                <h3 style={{ marginBottom: '0.5rem' }}>{r.primaryName}</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                  Aliases: {r.aliases?.slice(0, 3).join(', ') || 'None'}
                </p>
                {r.birthDates && r.birthDates.length > 0 && (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                    DOB: {r.birthDates.join(', ')}
                  </p>
                )}
              </div>
            ))}
            {results.length === 0 && !isLoading && (
              <p style={{ color: 'var(--text-muted)', gridColumn: '1 / -1', marginTop: '1rem' }}>
                No results. Enter a query and click Search.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <h2 style={{ marginBottom: '1rem' }}>Import Sanctions List</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>
            Upload CSV or XML files to sync with the database.
          </p>
          
          <label className="upload-area" style={{ display: 'block' }}>
            <input type="file" style={{ display: 'none' }} onChange={handleUpload} accept=".csv,.xml" />
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginBottom: '1rem', color: 'var(--primary)' }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            <h3>{isLoading ? 'Uploading...' : 'Click to browse files'}</h3>
            <p style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>Supported: CSV, XML</p>
          </label>
        </div>
      )}
    </div>
  );
}

export default App;
