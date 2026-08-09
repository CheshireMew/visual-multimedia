import {useLayoutEffect} from 'react';
import {FrameContext, type FrameState, useFrame} from './frame-context';
import './styles.css';

type FrameCommit = {
  generation: number;
  complete: () => void;
};

function seededUnit(seed: number): number {
  let value = seed | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4294967296;
}

function Scene() {
  const {seconds, frame} = useFrame();
  const progress = seconds / 4;
  const orbit = progress * Math.PI * 2;
  const jitter = (seededUnit(frame + 20260808) - 0.5) * 8;
  const x = 640 + Math.cos(orbit) * 260 + jitter;
  const y = 360 + Math.sin(orbit) * 150;

  return (
    <section id="mediaCanvas" className="canvas" aria-label="React 确定性网页成品包">
      <div className="grid" />
      <h1 data-editable-id="title" data-editable-data="title">
        React 只是生产方式
      </h1>
      <p className="subtitle">绝对时间 · 固定随机种子 · 封闭资源</p>
      <div
        data-editable-id="orbiter"
        className="orbiter"
        style={{transform: `translate(${x}px, ${y}px) rotate(${progress * 360}deg)`}}
      >
        <span>{frame}</span>
      </div>
      <div className="progress"><i style={{width: `${progress * 100}%`}} /></div>
      <output>{seconds.toFixed(3)}s / frame {frame}</output>
    </section>
  );
}

export function App({frame, commit}: {frame: FrameState; commit: FrameCommit | null}) {
  useLayoutEffect(() => {
    if (commit?.generation === frame.generation) commit.complete();
  }, [commit, frame.generation]);

  return (
    <FrameContext.Provider value={frame}>
      <Scene />
    </FrameContext.Provider>
  );
}
