import ReactDOM from 'react-dom/client';
import './styles/tokens.css';
import App from './App';

// StrictMode removed: causes double-mount which spawns duplicate PTY processes
ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />
);
