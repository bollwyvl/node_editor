// import { graph, nodes, NodeSchema, connections, exec } from "./api";
import {
  SerializedLGraphNode,
  LiteGraph,
  LGraph,
  LGraphCanvas,
  LGraphNode,
  LGraphGroup,
  INodeOutputSlot,
  INodeInputSlot,
  INodeSlot,
  LLink,
} from 'litegraph.js';

import { IExecuteReplyMsg } from '@jupyterlab/services/lib/kernel/messages';

import { Panel } from '@lumino/widgets';

import { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import { CodeCell } from '@jupyterlab/cells';

import { IFunctionSchema, INodeSchema, INodeSchemaIO } from './graph_api';

// @ts-ignore
import hash from 'object-hash';

// @ts-ignore
import converter from 'hsl-to-rgb-for-reals';

import { GraphAPI } from './graph_api';

const PYTHON_NODE = 1;
export interface IOParameters {
  name: string;
  node_id: number;
  socket: number;
  data: any;
}

export interface IExecuteCellOptions {
  id: number;
  info: IFunctionSchema;
  parameters: IOParameters[];
  cell: CodeCell;
}

export interface INodeCallback {
  (id: number, options: IExecuteCellOptions): Promise<IExecuteReplyMsg>;
}

enum NodeState {
  CLEAN = 1,
  MISSING = 2,
  DIRTY = 4,
  RUNNING = 8,
  ERROR = 16,
}

function configureSocket(id: string, optional: boolean): Partial<INodeSlot> {
  const h = hash(id);
  const maxVal = parseInt('f'.repeat(h.length), 16);
  const hue = Math.floor((parseInt(h, 16) / maxVal) * 360);
  const ret: Partial<INodeSlot> = {
    // eslint-disable-next-line @typescript-eslint/camelcase
    color_on: LiteGraph.num2hex(converter(hue, 1, 0.7)),
    // eslint-disable-next-line @typescript-eslint/camelcase
    color_off: LiteGraph.num2hex(converter(hue, 1, 0.65)),
  };
  if (optional) {
    ret.shape = LiteGraph.BOX_SHAPE;
  } else {
    ret.shape = LiteGraph.CARD_SHAPE;
  }
  return ret;
}

class PyLGraphNode extends LGraphNode {
  mode = LiteGraph.ALWAYS;

  static type: string;
  static title: string;
  private schema: IFunctionSchema;

  private graphHandler: GraphHandler;

  constructor(
    title: string,
    node: IFunctionSchema,
    graphHandler: GraphHandler
  ) {
    super(title);

    this.schema = node;
    this.graphHandler = graphHandler;
    this.title = this.schema.name;

    for (const [name, infos] of Object.entries(this.schema.inputs)) {
      const ntype = this.graphHandler.normalizeType(infos.type);
      const extra = this.graphHandler.getSocketConfiguration(
        ntype,
        infos.optional
      );
      this.addInput(name, ntype, extra);
    }

    for (const [name, infos] of Object.entries(this.schema.outputs)) {
      // TODO: cleaner
      const ntype = this.graphHandler.normalizeType(infos.type);
      this.addOutput(
        name,
        ntype,
        this.graphHandler.getSocketConfiguration(ntype, infos.optional)
      );
    }
    this.setState(NodeState.DIRTY);
    this.setProperty('count', 0);
    this.setProperty('previous_input', []);
    this.setProperty('type', PYTHON_NODE);
  }

  setProperty(key: string, value: any): void {
    // Missing declaration in d.ts file
    // @ts-ignore
    super.setProperty(key, value);
  }

  setState(state: NodeState): void {
    this.setProperty('state', state);
    // di
    const bgColors = {
      1: 'green', // Clean
      2: '#880000', // Missing
      4: 'purple', // Dirty
      8: 'blue', // Running
      16: '#ff0000' // Error
    };
    this.boxcolor = bgColors[state];
    // Redraw canvas
    this.setDirtyCanvas(false, true);
  }

  /**
   * returns whether the node is dirty, can run or is clean
   * @method getNodeState
   */
  updateNodeState(): NodeState {
    let { state } = this.properties;

    // If any input was modified: mark as dirty
    // If any input is missing: mark as missing
    for (let i = 0; i < this.inputs.length; i++) {
      const orig = this.getInputNode(i) as PyLGraphNode;
      const input = this.inputs[i];

      // Missing non-optional input
      if (!(this.schema.inputs[input.name].optional || orig)) {
        state = NodeState.MISSING;
        break;
      }
      if (!orig) {
        continue;
      }

      // Check upstream node was updated
      const prevInput = this.properties.previous_input[i];
      const newInput = this.getInputData(i);
      if (JSON.stringify(prevInput) !== JSON.stringify(newInput)) {
        state = NodeState.DIRTY;
      }
    }
    this.setState(state);
    return state;
  }

  onExecute(): void {
    const state = this.updateNodeState();
    if (state !== NodeState.DIRTY) {
      for (let iout = 0; iout < this.outputs.length; ++iout) {
        const val = this.getOutputData(iout) || 0;
        this.setOutputData(iout, val);
      }
      return;
    }

    this.setState(NodeState.RUNNING);

    this.graphHandler.graphAPI
      .executeNode(this.nodeSchema)
      .then(async value => {
        this.setState(NodeState.CLEAN);
      })
      .catch(reason => {
        console.error(
          `Failed to run node ${this.id}. Failed with reason\n${reason}`
        );
      });

    console.log(`Executing ${this.getTitle()} #${this.id}`);

    // Set previous input data
    const inputData = this.inputs.map((_input, index) => {
      return this.getInputData(index);
    });

    this.setProperty('previous_input', inputData);

    // We update the output *before* the node has run so that
    // nodes downstream also register to run.
    for (let iout = 0; iout < this.outputs.length; ++iout) {
      const val = this.getOutputData(iout) || 0;
      this.setOutputData(iout, val + 1);
    }
  }

  onRemoved(): void {
    this.graphHandler.graphAPI.removeNode(this.nodeSchema);
  }

  onAdded(): void {
    this.graphHandler.graphAPI.createNode(this.nodeSchema);
  }

  onAction(action: string, param: any): void {
    console.log(action);
  }

  onSelected(): void {
    this.graphHandler.graphAPI.selectFunction(this.schema);
    this.graphHandler.graphAPI.selectNode(this.nodeSchema);
  }

  onDeselected(): void {
    this.graphHandler.graphAPI.deselectFunction();
    this.graphHandler.graphAPI.deselectNode();
  }

  onConnectionsChange(
    type: number,
    slotIndex: number,
    isConnected: boolean,
    link: LLink,
    ioSlot: INodeOutputSlot | INodeInputSlot
  ): void {
    this.graphHandler.graphAPI.updateNode(this.nodeSchema);
    this.updateNodeState();
  }

  onConfigure(o: SerializedLGraphNode): void {
    this.setState(NodeState.DIRTY);
  }

  /** Return a node schema without building the inputs node schemas */
  buildNodeSchema(depth: number): INodeSchema {
    const inputs: { [paramName: string]: INodeSchemaIO } = {};
    this.inputs.forEach((input, islot) => {
      const ancestor = this.getInputNode(islot);
      const optional = this.schema.inputs[input.name].optional;
      if (!ancestor) {
        inputs[input.name] = { type: 'value', input: null, optional };
        return;
      }

      if (ancestor.properties['type'] === PYTHON_NODE) {
        let inputData;
        if (depth > 0) {
          inputData = (ancestor as PyLGraphNode).buildNodeSchema(depth - 1);
        } else {
          inputData = this.getInputData(islot);
        }
        inputs[input.name] = {
          type: 'node',
          input: inputData,
          optional
        };
      } else {
        const inputData = this.getInputData(islot, true);
        inputs[input.name] = {
          type: 'value',
          input: inputData,
          optional
        };
      }
    });

    return {
      id: this.id,
      function: this.schema,
      inputs: inputs
    };
  }

  get nodeSchema(): INodeSchema {
    return this.buildNodeSchema(1);
  }

  get nodeSchemaDeep(): INodeSchema {
    return this.buildNodeSchema(99999999);
  }
}

export function nodeFactory(gh: GraphHandler, node: IFunctionSchema): void {
  class NewNode extends PyLGraphNode {
    constructor(title?: string) {
      super(title, node, gh);
    }
    static graphHandler = gh;
    static type = `mynodes/${node.name}`;
    static title = node.name;
  }

  LiteGraph.registerNodeType(`mynodes/${node.name}`, NewNode);
}

export class GraphHandler {
  private _graph: LGraph;

  private canvas: LGraphCanvas;

  private socketConfiguration: { [id: string]: Partial<INodeSlot> };

  private callbacks: { [id: string]: Array<Function> } = {
    loaded: []
  };

  private hasLoaded = false;

  /** The widget in which code cells will be included */
  private _widget: Panel;

  private _rendermime: IRenderMimeRegistry;

  private known_types: { [id: string]: string | null } = {
    'typing.Any': null,
    "<class 'str'>": 'string',
    "<class 'int'>": 'int',
    "<class 'float'>": 'float',
    "<class 'bool'>": 'boolean'
  };

  executeCell: INodeCallback;
  private _graphAPI: GraphAPI;

  constructor(id: string, graphAPI: GraphAPI) {
    this.setupGraph();
    this.setupCanvas(id);

    this.socketConfiguration = {};

    this._graphAPI = graphAPI;
  }

  setupGraph(): void {
    // Empty list of registered node types
    // LiteGraph.clearRegisteredTypes()

    // TODO: do not recreate a graph each time the widget is
    // detached, simply reattach to a new canvas
    this._graph = new LGraph();

    // Reduce font size for groups
    // @ts-ignore
    const prevCtor = LGraphGroup.prototype._ctor;
    // @ts-ignore
    LGraphGroup.prototype._ctor = function (title): void {
      prevCtor.bind(this)(title);
      // @ts-ignore
      // eslint-disable-next-line @typescript-eslint/camelcase
      this.font_size = 14;
    };

    // Add custom events
    const graph = this._graph;
    for (const nodeClass of Object.values(LiteGraph.Nodes)) {
      nodeClass.prototype.onKeyUp = function (e: KeyboardEvent): void {
        if (e.key === 'Delete') {
          graph.remove(this);
        }
      };
    }
  }

  setupCanvas(containerId: string): void {
    this.canvas = new LGraphCanvas(containerId, this._graph);
    const font = getComputedStyle(document.documentElement).getPropertyValue(
      '--jp-ui-font-family'
    );
    // eslint-disable-next-line @typescript-eslint/camelcase
    this.canvas.title_text_font = font;
    // eslint-disable-next-line @typescript-eslint/camelcase
    this.canvas.inner_text_font = font;
  }

  createFunction(schema: IFunctionSchema): void {
    // TODO: check the schema does not already exist
    nodeFactory(this, schema);
  }

  normalizeType(type: string): string {
    if (type in this.known_types) {
      return this.known_types[type];
    } else {
      return this.graphAPI.getParentType(type);
    }
  }

  loadComponents(allNodes: Array<IFunctionSchema>): void {
    console.log(LiteGraph);
    for (const node of Object.values(allNodes)) {
      if (node.name in LiteGraph.Nodes) {
        // TODO: update schema
        // const lgNode = LiteGraph.Nodes[node.name];
      } else {
        // New node
        nodeFactory(this, node);
      }
    }

    this.hasLoaded = true;
    while (this.callbacks.loaded.length > 0) {
      this.callbacks.loaded.pop()();
    }
  }

  on(event: string, callback: Function): void {
    this.callbacks[event].push(callback);
  }

  getSocketConfiguration(
    socket: string,
    optional: boolean
  ): Partial<INodeSlot> {
    if (socket in this.socketConfiguration) {
      return this.socketConfiguration[socket];
    }
    const config = configureSocket(socket, optional);
    this.socketConfiguration[socket] = config;
    return config;
  }

  save(): void {
    // TODO
    // let data = this.graph.serialize();
    // graph.create(data);
  }

  load(name?: string): void {
    const loadNow = function (): void {
      // TODO
      // graph.index().then(reply => {
      //     this.graph.configure(reply.data);
      // });
    };
    if (this.hasLoaded) {
      loadNow();
    } else {
      this.on('loaded', loadNow);
    }
  }

  createComponents(data: string): void {
    const conf = JSON.parse(data);
    this.loadComponents(conf);
  }

  loadGraph(data: string): void {
    const conf = JSON.parse(data);
    this._graph.configure(conf);
  }

  get graph(): LGraph {
    return this._graph;
  }

  get widget(): Panel {
    return this._widget;
  }

  get rendermime(): IRenderMimeRegistry {
    return this._rendermime;
  }

  get graphAPI(): GraphAPI {
    return this._graphAPI;
  }
}
