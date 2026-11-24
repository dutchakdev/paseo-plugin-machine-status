import fs from "node:fs/promises";
import path from "node:path";

const read = (file: string) => fs.readFile(file, "utf8").then((value) => value.trim()).catch(() => null);
const entries = (directory: string) => fs.readdir(directory).catch(() => [] as string[]);

export function parseMeminfo(raw: string) {
  const bytes = new Map([...raw.matchAll(/^(\w+):\s+(\d+) kB$/gm)]
    .map(([, key, value]) => [key, Number(value) * 1024]));
  const totalBytes = bytes.get("MemTotal");
  const available = bytes.get("MemAvailable");
  if (!totalBytes || available === undefined) throw new Error("Missing MemTotal or MemAvailable in /proc/meminfo.");
  const freeBytes = Math.min(totalBytes, available);
  const usedBytes = totalBytes - freeBytes;
  const swapTotal = bytes.get("SwapTotal") ?? 0;
  const swapFree = Math.min(swapTotal, bytes.get("SwapFree") ?? 0);
  return {
    memory: {
      totalBytes,
      usedBytes,
      appBytes: usedBytes,
      wiredBytes: 0,
      compressedBytes: 0,
      cachedBytes: Math.max(0, (bytes.get("Cached") ?? 0) - (bytes.get("Shmem") ?? 0)),
      freePercent: freeBytes * 100 / totalBytes,
      pressurePercent: null,
    },
    swap: { totalBytes: swapTotal, usedBytes: swapTotal - swapFree, freeBytes: swapFree },
  };
}

export function parsePsi(raw: string | null): number | null {
  const match = raw?.match(/^some avg10=(\d+(?:\.\d+)?)\s/m);
  return match ? Number(match[1]) : null;
}

async function readPower() {
  const directory = "/sys/class/power_supply";
  const supplies = await Promise.all((await entries(directory)).map(async (name) => {
    const base = path.join(directory, name);
    const [type, scope, present, online, capacity, status, remaining] = await Promise.all(
      ["type", "scope", "present", "online", "capacity", "status", "time_to_empty_now"]
        .map((field) => read(path.join(base, field))),
    );
    return { type, scope, present, online, capacity, status, remaining };
  }));
  const battery = supplies.find((supply) => supply.type === "Battery" && supply.scope !== "Device" && supply.present !== "0");
  const source = supplies.some((supply) => supply.type !== "Battery" && supply.scope !== "Device" && supply.online === "1")
    || battery?.status === "Charging" ? "ac" : battery?.status === "Discharging" ? "battery" : "unknown";
  return {
    source,
    percent: battery?.capacity?.match(/^\d+$/) ? Math.min(100, Number(battery.capacity)) : null,
    state: battery?.status ?? null,
    timeRemainingMinutes: source === "battery" && battery?.remaining?.match(/^\d+$/)
      ? Math.round(Number(battery.remaining) / 60) : null,
  } as const;
}

async function temperature(type: string | null, file: string) {
  const temp = await read(file);
  const celsius = temp?.match(/^-?\d+$/) ? Number(temp) / 1000 : NaN;
  return type && celsius > -40 && celsius < 150 ? { type, celsius } : null;
}

async function readTemperature() {
  const thermal = "/sys/class/thermal";
  const hwmon = "/sys/class/hwmon";
  const [zones, monitors] = await Promise.all([entries(thermal), entries(hwmon)]);
  const readings = await Promise.all([
    ...zones.filter((name) => /^thermal_zone\d+$/.test(name)).map(async (name) => {
      const base = path.join(thermal, name);
      return temperature(await read(path.join(base, "type")), path.join(base, "temp"));
    }),
    ...monitors.map(async (name) => {
      const base = path.join(hwmon, name);
      const driver = await read(path.join(base, "name"));
      if (!driver || !["coretemp", "k10temp", "zenpower"].includes(driver)) return null;
      // The first sensor is the Intel package or the AMD control temperature.
      const label = await read(path.join(base, "temp1_label"));
      return temperature(label ? `${driver} · ${label}` : driver, path.join(base, "temp1_input"));
    }),
  ]);
  return readings.flatMap((sensor) => sensor ? [sensor] : []);
}

export async function readLinuxMetrics() {
  const [meminfo, power, temperatures, cpu, memory, io] = await Promise.all([
    fs.readFile("/proc/meminfo", "utf8"),
    readPower(), readTemperature(), read("/proc/pressure/cpu"), read("/proc/pressure/memory"), read("/proc/pressure/io"),
  ]);
  return {
    ...parseMeminfo(meminfo),
    power,
    thermal: { level: "unknown", cpuSpeedLimitPercent: null, temperatures } as const,
    stalls: { cpu: parsePsi(cpu), memory: parsePsi(memory), io: parsePsi(io) },
  };
}
