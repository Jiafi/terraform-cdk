// Each action drives itself to completion and exposes updates to the user.

import { assign, createMachine } from "xstate";
import { SynthStack, SynthesizedStack } from "./synth-stack";
import { Errors } from "./errors";
import { TerraformJson } from "../bin/cmds/ui/terraform-json";
import { TerraformCloud } from "./models/terraform-cloud";
import { TerraformCli } from "./models/terraform-cli";
import {
  TerraformPlan,
  Terraform,
  DeployingResource,
} from "./models/terraform";
import { getConstructIdsForOutputs, parseOutput } from "./output";
import { printAnnotations } from "./synth";

export type ProjectEvent =
  | {
      type: "START";
      targetAction?: "synth" | "diff" | "deploy" | "destroy" | "output";
      targetStack?: string;
    }
  | {
      type: "APPROVAL_ABORTED";
    }
  | {
      type: "APPROVAL_GIVEN";
    };

type ProgressEvent =
  | {
      type: "STACK_SELECTED";
      stackName: string;
    }
  | {
      type: "LOG";
      stackName: string;
      stateName: string;
      message: string;
      isError: boolean;
    }
  | {
      type: "RESOURCE_UPDATE";
      stackName: string;
      stateName: string;
      stdout: string;
      updatedResources: DeployingResource[];
    };

export interface ProjectContext {
  targetAction?: "synth" | "diff" | "deploy" | "destroy" | "output";
  targetStack?: string;
  message?: string;
  synthesizedStacks?: SynthesizedStack[];
  targetStackPlan?: TerraformPlan;
  autoApprove?: boolean;
  synthCommand: string;
  outDir: string;
  workingDirectory: string;
  outputs?: Record<string, any>;
  outputsByConstructId?: Record<string, any>;
  onProgress: (event: ProgressEvent) => void;
}

function getStack(
  context: ProjectContext,
  stackName = context.targetStack
): SynthesizedStack {
  const stacks = context.synthesizedStacks;
  if (!stacks) {
    throw Errors.Internal(
      "Trying to access a stack before it has been synthesized"
    );
  }
  if (stackName) {
    const stack = stacks.find((s) => s.name === stackName);
    if (!stack) {
      throw Errors.Usage("Unknown stack: " + stackName);
    }

    return stack;
  }

  if (stacks.length !== 1) {
    throw Errors.Usage(
      `Found more than one stack, please specify a target stack. Run cdktf ${
        context.targetAction || "<verb>"
      } <stack> with one of these stacks: ${stacks
        .map((s) => s.name)
        .join(", ")} `
    );
  }

  return stacks[0];
}

function getLogCallbackForStack(
  context: ProjectContext,
  stateName: string
): (message: string, isError?: boolean) => void {
  const stack = getStack(context);
  return (message: string, isError = false) => {
    context.onProgress({
      type: "LOG",
      stackName: stack.name,
      stateName,
      message,
      isError,
    });
  };
}

async function getTerraformClient(
  stack: SynthesizedStack,
  isSpeculative: boolean,
  sendLog: (message: string, isError?: boolean) => void
): Promise<Terraform> {
  const parsedStack = JSON.parse(stack.content) as TerraformJson;

  if (parsedStack.terraform?.backend?.remote) {
    const tfClient = new TerraformCloud(
      stack,
      parsedStack.terraform.backend.remote,
      isSpeculative,
      sendLog
    );
    if (await tfClient.isRemoteWorkspace()) {
      return tfClient;
    }
  }
  return new TerraformCli(stack, sendLog);
}

const services = {
  synthProject: async (context: ProjectContext) => {
    const stacks = await SynthStack.synth(
      context.synthCommand,
      context.outDir,
      context.workingDirectory
    );

    printAnnotations(stacks);

    return stacks;
  },
  diff: async (context: ProjectContext) => {
    const stack = getStack(context);
    context.onProgress({
      type: "STACK_SELECTED",
      stackName: stack.name,
    });
    const terraform = await getTerraformClient(
      stack,
      true,
      getLogCallbackForStack(context, "plan")
    );
    await terraform.init();
    return terraform.plan(context.targetAction === "destroy");
  },
  deploy: async (context: ProjectContext) => {
    const planFile = context.targetStackPlan?.planFile;
    if (!planFile) {
      throw Errors.Internal("No plan file found, diff needs to be run first");
    }

    const stack = getStack(context);
    const terraform = await getTerraformClient(
      stack,
      false,
      getLogCallbackForStack(context, "apply")
    );

    await terraform.deploy(planFile, (chunk: Buffer) => {
      const stdout = chunk.toString("utf8");

      context.onProgress({
        type: "RESOURCE_UPDATE",
        stackName: stack.name,
        stateName: "deploy",
        stdout,
        updatedResources: parseOutput(stdout),
      });
    });
  },
  destroy: async (context: ProjectContext) => {
    const planFile = context.targetStackPlan?.planFile;
    if (!planFile) {
      throw Errors.Internal("No plan file found, diff needs to be run first");
    }

    const stack = getStack(context);
    const terraform = await getTerraformClient(
      stack,
      false,
      getLogCallbackForStack(context, "destroy")
    );

    await terraform.destroy((chunk: Buffer) => {
      const stdout = chunk.toString("utf8");

      context.onProgress({
        type: "RESOURCE_UPDATE",
        stackName: stack.name,
        stateName: "deploy",
        stdout,
        updatedResources: parseOutput(stdout),
      });
    });
  },
  gatherOutput: async (context: ProjectContext) => {
    if (context.targetAction === "destroy") {
      return Promise.resolve({});
    }

    const stack = getStack(context);
    const terraform = await getTerraformClient(
      stack,
      false,
      getLogCallbackForStack(context, "output")
    );
    const outputs = await terraform.output();
    const outputsByConstructId = getConstructIdsForOutputs(
      JSON.parse(stack.content),
      outputs
    );

    return Promise.resolve({ outputs, outputsByConstructId });
  },
};

const guards = {
  onTargetAction: (
    context: ProjectContext,
    _event: any,
    state: { cond: { value: string } } // https://xstate.js.org/docs/guides/guards.html#custom-guards
  ) => context.targetAction === state.cond.value,
  autoApprove: (context: ProjectContext) => Boolean(context.autoApprove),
  planNeedsNoApply: (
    _context: ProjectContext,
    event: { data: TerraformPlan }
  ) => event.data.needsApply === false,
};

const projectExecutionMachine = createMachine<ProjectContext, ProjectEvent>(
  {
    id: "project",
    initial: "idle",
    context: {
      onProgress: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
      // Mandatorily set by withContext
      synthCommand: "",
      workingDirectory: "",
      outDir: "",
    },
    states: {
      idle: {
        on: {
          START: {
            target: "synth",
            actions: assign({
              targetAction: (_context, event) => event.targetAction,
              targetStack: (_context, event) => event.targetStack,
            }),
          },
        },
      },
      synth: {
        invoke: {
          id: "synth",
          src: "synthProject",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) => event.data,
            }),
          },
          onDone: [
            {
              target: "done",
              actions: assign({
                synthesizedStacks: (_context, event) => event.data,
              }),
              cond: {
                type: "onTargetAction",
                name: "actionIsSynth",
                value: "synth",
              },
            },
            {
              target: "gatherOutput",
              actions: assign({
                synthesizedStacks: (_context, event) => event.data,
              }),
              cond: {
                type: "onTargetAction",
                name: "actionIsOutput",
                value: "output",
              },
            },
            {
              target: "diff",
              actions: assign({
                synthesizedStacks: (_context, event) => event.data,
              }),
            },
          ],
        },
      },
      diff: {
        invoke: {
          id: "diff",
          src: "diff",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) => {
                const errorMessage = event.data.stderr || event.data;
                return `terraform plan errored with: \n${errorMessage}`;
              },
            }),
          },
          onDone: [
            {
              target: "done",
              actions: assign({
                targetStackPlan: (_context, event) => event.data,
              }),
              cond: {
                type: "onTargetAction",
                name: "actionIsDiff",
                value: "diff",
              },
            },

            {
              actions: assign({
                targetStackPlan: (_context, event) => event.data,
              }),
              target: "gatherOutput",
              cond: "planNeedsNoApply",
            },
            {
              actions: assign({
                targetStackPlan: (_context, event) => event.data,
              }),
              target: "approved",
              cond: "autoApprove",
            },
            {
              actions: assign({
                targetStackPlan: (_context, event) => event.data,
              }),
              target: "waitingForApproval",
            },
          ],
        },
      },
      waitingForApproval: {
        on: {
          APPROVAL_ABORTED: {
            target: "done",
          },
          APPROVAL_GIVEN: {
            target: "approved",
          },
        },
      },
      approved: {
        always: [
          {
            target: "deploy",
            cond: {
              type: "onTargetAction",
              name: "actionIsDiff",
              value: "deploy",
            },
          },
          {
            target: "destroy",
            cond: {
              type: "onTargetAction",
              name: "actionIsDiff",
              value: "destroy",
            },
          },
        ],
      },
      deploy: {
        invoke: {
          id: "deploy",
          src: "deploy",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) => event.data,
            }),
          },
          onDone: {
            target: "gatherOutput",
          },
        },
      },
      destroy: {
        invoke: {
          id: "destroy",
          src: "destroy",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) => event.data,
            }),
          },
          onDone: {
            target: "gatherOutput",
          },
        },
      },
      gatherOutput: {
        invoke: {
          id: "gatherOutput",
          src: "gatherOutput",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) => event.data,
            }),
          },
          onDone: {
            target: "done",
            actions: assign({
              outputs: (_context, event) => event.data.outputs,
              outputsByConstructId: (_context, event) =>
                event.data.outputsByConstructId,
            }),
          },
        },
      },
      done: {
        type: "final",
      },
      error: {
        type: "final",
      },
    },
  },
  { services, guards: guards as any }
);

export { projectExecutionMachine, guards, services };
