import React from 'react'
import ReactDOM from 'react-dom/client'

function TestApp() {
  const [msg, setMsg] = React.useState('Loading...')

  React.useEffect(() => {
    let mounted = true
    async function init() {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const result = await invoke('ping_book', { book_id: 'shengshi_001' })
        if (mounted) setMsg(JSON.stringify(result, null, 2))
      } catch(e: any) {
        if (mounted) setMsg('No Tauri: ' + (e?.message || String(e)))
      }
    }
    init()
    return () => { mounted = false }
  }, [])

  return React.createElement('div', { style: { padding: 40, fontFamily: 'monospace', color: '#ccc', background: '#111', minHeight: '100vh' } },
    React.createElement('h1', null, 'Novel Agent - Test'),
    React.createElement('pre', null, msg)
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  React.createElement(TestApp)
)
