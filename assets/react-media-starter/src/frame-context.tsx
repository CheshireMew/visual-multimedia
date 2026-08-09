import {createContext, useContext} from 'react';

export type FrameState = {
  seconds: number;
  generation: number;
  fps: number;
  frame: number;
};

export const FrameContext = createContext<FrameState>({
  seconds: 0,
  generation: 0,
  fps: 30,
  frame: 0,
});

export function useFrame(): FrameState {
  return useContext(FrameContext);
}
