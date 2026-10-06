import { useEffect, useRef } from "react";
import { openStep, type StepLayer } from "../utils/backSteps";

/**
 * While `active`, Back calls `onBack` instead of leaving cour
 * (utils/backSteps). `onBack` returns false to refuse; the step stays.
 */
export const useBackStep = (active: boolean, onBack: () => unknown, layer: StepLayer = "screen") => {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    return openStep(() => onBackRef.current(), layer);
  }, [active, layer]);
};
