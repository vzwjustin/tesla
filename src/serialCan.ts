import { SerialPort } from "serialport";
import { decodeVerifiedModel3YCan, EXTENDED_CAN_MESSAGES, parseElmCanLine, type BmsDiagnosticSnapshot, type CanFrame } from "./scanMyTesla.js";

// "battery" = the three battery messages (default). "extended" also listens to each further Scan My Tesla-style
// message in EXTENDED_CAN_MESSAGES for EXTENDED_SECONDS_PER_ID, about 15 s more in total (10 IDs, 1 s window plus about 0.5 s of adapter commands each).
export type CaptureProfile = "battery" | "extended";
const EXTENDED_SECONDS_PER_ID = 1;

export type SerialPortInfo = { path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string; pnpId?: string; };

export async function listSerialCanPorts(): Promise<SerialPortInfo[]> {
  const ports = await SerialPort.list();
  return ports.map(port => ({
    path: port.path,
    ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}),
    ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}),
    ...(port.vendorId ? { vendorId: port.vendorId } : {}),
    ...(port.productId ? { productId: port.productId } : {}),
    ...(port.pnpId ? { pnpId: port.pnpId } : {}),
  }));
}

function openPort(port: SerialPort): Promise<void> {
  return new Promise((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
}

function closePort(port: SerialPort): Promise<void> {
  return new Promise(resolve => port.close(() => resolve()));
}

function writePort(port: SerialPort, command: string): Promise<void> {
  return new Promise((resolve, reject) => port.write(command, error => error ? reject(error) : port.drain(drainError => drainError ? reject(drainError) : resolve())));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Receive-filter phases as [hex CAN ID, seconds]. Battery IDs split durationSeconds; extended IDs add a fixed window each.
export function capturePhases(durationSeconds: number, profile: CaptureProfile = "battery"): Array<[string, number]> {
  const battery: Array<[string, number]> = [["352", 0.2 * durationSeconds], ["332", 0.3 * durationSeconds], ["401", 0.5 * durationSeconds]];
  if (profile !== "extended") return battery;
  return [...battery, ...Object.keys(EXTENDED_CAN_MESSAGES).map(Number).filter(id => id !== 0x352).map((id): [string, number] => [id.toString(16).toUpperCase(), EXTENDED_SECONDS_PER_ID])];
}

export async function capturePassiveElmCan(input: { path: string; baudRate: number; durationSeconds: number; profile?: CaptureProfile }): Promise<{ snapshot: BmsDiagnosticSnapshot; frameCount: number; rawLinesDropped: number; adapterTranscript: string[]; profile: CaptureProfile }> {
  const profile = input.profile ?? "battery";
  const port = new SerialPort({ path: input.path, baudRate: input.baudRate, autoOpen: false, lock: true });
  const chunks: string[] = [];
  const transcript: string[] = [];
  let buffer = "";
  const frames: CanFrame[] = [];
  let dropped = 0;

  port.on("data", data => {
    buffer += data.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      chunks.push(trimmed);
      const frame = parseElmCanLine(trimmed);
      if (frame) frames.push(frame); else if (!trimmed.includes(">") && !/^OK$/i.test(trimmed) && !/^ELM327/i.test(trimmed) && !/^STN/i.test(trimmed)) dropped += 1;
    }
  });

  try {
    await openPort(port);
    // Adapter-only initialization. No CAN request frame or Tesla command is ever sent.
    // ATSP6 pins 500 kbit/11-bit CAN so the adapter never runs its OBD protocol search (which transmits).
    // ATCSM1 = silent monitoring (no ACKs); older clones answer "?" and are already silent by default.
    // ATH1 shows IDs, ATCAF0 shows raw bytes; the parser needs both.
    for (const command of ["ATZ\r", "ATE0\r", "ATL0\r", "ATSP6\r", "ATCSM1\r", "ATH1\r", "ATS1\r", "ATD1\r", "ATCAF0\r"]) {
      transcript.push(command.trim());
      await writePort(port, command);
      await sleep(command.startsWith("ATZ") ? 1250 : 120);
    }
    // ponytail: one receive filter per ID in turn; unfiltered ATMA overruns ELM327 buffers on the vehicle bus.
    // 0x401 gets half the time because bricks arrive one multiplex group per frame.
    for (const [id, seconds] of capturePhases(input.durationSeconds, profile)) {
      for (const command of [`ATCRA${id}\r`, "ATMA\r"]) {
        transcript.push(command.trim());
        await writePort(port, command);
        await sleep(120);
      }
      await sleep(seconds * 1000);
      // A carriage return ends ELM/STN monitor mode. It does not transmit a CAN frame.
      await writePort(port, "\r");
      await sleep(300);
    }
    await writePort(port, "ATCRA\r");
    await sleep(120);
  } finally {
    if (port.isOpen) await closePort(port);
  }

  return {
    snapshot: decodeVerifiedModel3YCan(frames),
    frameCount: frames.length,
    rawLinesDropped: dropped,
    adapterTranscript: transcript,
    profile,
  };
}
