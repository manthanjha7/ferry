// A stand-in for Claude Design's animation engine, written for this test: the
// same contract (a scene list in OM_SCENES, one component mounted through
// x-import, an <svg data-om-exportable-video-with-duration-secs> stage that
// seeks on a `data-om-seek-to-time-frame` event) and none of its code.
const { useState, useEffect, useRef } = React;

function MiniStage({ width, height, children }) {
  const [time, setTime] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    const onSeek = (e) => setTime(e.detail.time);
    el.addEventListener("data-om-seek-to-time-frame", onSeek);
    el.setAttribute("data-om-sync-seek", "true");
    return () => el.removeEventListener("data-om-seek-to-time-frame", onSeek);
  }, []);
  return (
    <svg ref={ref} width={width} height={height} data-om-exportable-video-with-duration-secs={3} style={{ transform: "scale(0.5)" }}>
      <foreignObject x="0" y="0" width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" data-name="Composition" style={{ width, height, background: "#101418", position: "relative" }}>
          {children(time)}
        </div>
      </foreignObject>
    </svg>
  );
}

const ramp = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));

function MiniPiece() {
  return (
    <MiniStage width={800} height={450}>
      {(t) => (
        <>
          <p data-name="Hello" style={{ position: "absolute", left: 40, top: 40, margin: 0, color: "#fff", fontSize: 40, opacity: ramp(t, 0, 0.5) }}>Hello</p>
          <p data-name="World" style={{ position: "absolute", left: 40, top: 120, margin: 0, color: "#fff", fontSize: 40, opacity: ramp(t, 1.1, 1.4) }}>World</p>
          <p data-name="Bye" style={{ position: "absolute", left: 40, top: 200, margin: 0, color: "#fff", fontSize: 40, opacity: t < 2.5 ? ramp(t, 2.05, 2.3) : 1 - ramp(t, 2.7, 2.95) }}>Bye</p>
        </>
      )}
    </MiniStage>
  );
}

Object.assign(window, { MiniPiece });
