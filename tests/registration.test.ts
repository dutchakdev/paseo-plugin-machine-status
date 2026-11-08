import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import contribute from "../index.server";
import * as attribution from "../shared/attribution";
import * as contracts from "../shared/contracts";
import * as docker from "../shared/docker";
import * as explain from "../shared/explain";
import * as services from "../shared/services";

type Contract = { name: string; input: unknown; output: unknown };
const isContract = (value: unknown): value is Contract =>
  typeof value === "object" && value !== null && "name" in value && "input" in value && "output" in value;

// Every RPC the client can call. A contract without a handler fails only at
// runtime, as an RPC rejection the moment the user presses its button.
const declared = [attribution, contracts, docker, explain, services]
  .flatMap((module) => Object.values(module).filter(isContract))
  .map((contract) => contract.name);

function registered() {
  const names: string[] = [];
  const server = {
    handle: (contract: Contract) => {
      names.push(contract.name);
    },
    before: () => () => {},
  } as unknown as PluginServerContext;
  contribute(server);
  return names;
}

describe("server registration", () => {
  it("adds its agent tools through the session-open hook", () => {
    const hooks: string[] = [];
    contribute({ handle: () => {}, before: (name: string) => (hooks.push(name), () => {}) } as unknown as PluginServerContext);
    expect(hooks).toEqual(["agent.session_open"]);
  });

  it("still registers on a host without request hooks", () => {
    expect(() => contribute({ handle: () => {} } as unknown as PluginServerContext)).not.toThrow();
  });

  it("declares contracts to check", () => {
    expect(declared.length).toBeGreaterThan(10);
  });

  it("registers a handler for every RPC contract the client can call", () => {
    expect([...registered()].sort()).toEqual([...declared].sort());
  });

  it("registers each handler once", () => {
    const names = registered();
    expect(new Set(names).size).toBe(names.length);
  });
});
