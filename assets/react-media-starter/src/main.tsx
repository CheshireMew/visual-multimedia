import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {App} from './App';

const fps = 30;
const rootNode = document.getElementById('root');
if (!rootNode) throw new Error('React editable-media root is missing');
const root = createRoot(rootNode);
const query = new URLSearchParams(location.search);
const baseDelay = Math.max(0, Number(query.get('frame_delay_ms') || 0));
const failOnceFrame = query.has('fail_once_frame')
  ? Number(query.get('fail_once_frame'))
  : null;
const retryFrame = query.has('__hf_retry_frame')
  ? Number(query.get('__hf_retry_frame'))
  : null;
const retryAttempt = Math.max(1, Number(query.get('__hf_retry_attempt') || 1));
const failedFrames = new Set<number>();

function renderInitial() {
  flushSync(() => root.render(
    <StrictMode>
      <App frame={{seconds: 0, generation: 0, fps, frame: 0}} commit={null} />
    </StrictMode>,
  ));
}

window.__hf.registerRenderer('react-19-root', ({seconds, generation}) => {
  const frame = Math.round(seconds * fps);
  const handle = window.__hf.deferFrame({
    label: 'react:layout-commit',
    timeout_ms: 5000,
    retryable: true,
  });
  return new Promise<void>((resolve) => {
    const complete = () => {
      const finish = () => {
        const resumedRetry = retryFrame === frame && retryAttempt > 1;
        if (failOnceFrame === frame && !failedFrames.has(frame) && !resumedRetry) {
          failedFrames.add(frame);
          window.__hf.rejectFrame(handle, {
            code: 'react_frame_retry',
            message: `Intentional retry probe for frame ${frame}`,
            retryable: true,
          });
        } else {
          window.__hf.resolveFrame(handle);
        }
        resolve();
      };
      const deterministicDelay = baseDelay + (frame % 3) * 5;
      if (deterministicDelay > 0) setTimeout(finish, deterministicDelay);
      else finish();
    };
    flushSync(() => root.render(
      <StrictMode>
        <App
          frame={{seconds, generation, fps, frame}}
          commit={{generation, complete}}
        />
      </StrictMode>,
    ));
  });
});

renderInitial();
