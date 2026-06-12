import { useState } from 'react';

interface Props {
  sessionId?: string;
}

export function BrowserPanel({ sessionId }: Props) {
  const [url, setUrl] = useState('https://www.google.com');
  const [browsers, setBrowsers] = useState<any[]>([]);

  const handleOpen = async () => {
    if (!sessionId) return;
    try {
      const result = await window.electronAPI.createBrowser(url, sessionId);
      setBrowsers(prev => [...prev, result]);
    } catch (err) {
      console.error('Failed to create browser:', err);
    }
  };

  const handleDestroy = async (id: string) => {
    await window.electronAPI.destroyBrowser(id);
    setBrowsers(prev => prev.filter(b => b.id !== id));
  };

  return (
    <div style={{ padding:'8px', borderTop:'1px solid var(--hairline)' }}>
      <div style={{ display:'flex', gap:6, alignItems:'center' }}>
        <input value={url} onChange={e => setUrl(e.target.value)}
          placeholder="URL..."
          style={{ flex:1, background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'4px 8px', fontSize:11, fontFamily:'var(--font-mono)', outline:'none' }} />
        <button onClick={handleOpen} disabled={!sessionId}
          style={{ background:'var(--accent)', border:'none', borderRadius:3, color:'#fff', padding:'4px 10px', cursor:'pointer', fontSize:11, fontFamily:'var(--font-sans)', opacity: sessionId?1:0.4 }}>
          🌐 Open
        </button>
      </div>
      {browsers.length > 0 && (
        <div style={{ marginTop:6, fontSize:10, color:'var(--caption)' }}>
          {browsers.map((b: any) => (
            <div key={b.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'2px 0' }}>
              <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.url}</span>
              <button onClick={() => handleDestroy(b.id)}
                style={{ background:'none', border:'none', color:'var(--failed)', cursor:'pointer', fontSize:12 }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
