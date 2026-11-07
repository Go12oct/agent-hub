import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentHub } from './ui/AgentHub';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AgentHub />
  </React.StrictMode>,
);
