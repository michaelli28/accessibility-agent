import React from 'react';
import { createRoot } from 'react-dom/client';

const App = () => {
  return (
    <div>
      <h1>Accessibility Driver Debugger</h1>
      <div id="live-mirror">Live Mirror Placeholder</div>
      <div id="transcript">Transcript Placeholder</div>
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
