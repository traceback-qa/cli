/**
 * Relay tunnel infrastructure — the CLI side of the custom relay: a binary frame
 * codec (lockstep with the backend) and the long-lived agent client that serves a
 * local dev server to cloud devices through the backend.
 */

export {
  CONTROL_CHANNEL,
  ControlOp,
  FLAG_FIN,
  FrameType,
  HEADER_SIZE,
  MAGIC,
  VERSION,
  controlPayload,
  decodeFrame,
  encodeControl,
  encodeFrame,
  parseControl,
  tryParseFrame,
  type Frame,
  type TryParseResult,
} from './frame.js';
export {
  RelayAgentClient,
  type RelayAgentClientOptions,
  type RelayHttpRequest,
  type RelayReadyInfo,
  type RelayRebuildRequest,
  type RelayRebuildResult,
} from './relay.client.js';
