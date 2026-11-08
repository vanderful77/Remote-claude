import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { EventBody, EventEnvelope } from "@rc/core";

/**
 * 带序号的事件环形缓冲。
 *
 * 断线补发的关键：每个事件有递增序号 seq；客户端记住最后收到的 seq，
 * 重连时说"我收到 N 为止"，服务端补发 N 之后的事件。
 * bootId 标识"这一次 daemon 进程"：daemon 重启后序号从 1 重来，
 * 客户端拿旧 bootId 来订阅时，服务端就知道它的 seq 没意义，要求它从头开始。
 */
export class EventLog extends EventEmitter<{ append: [EventEnvelope] }> {
  readonly bootId = randomBytes(8).toString("hex");
  private buf: EventEnvelope[] = [];
  private seq = 0;

  constructor(private readonly capacity: number) {
    super();
  }

  append(body: EventBody, ts = Date.now()): EventEnvelope {
    const ev: EventEnvelope = { seq: ++this.seq, ts, body };
    this.buf.push(ev);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    this.emit("append", ev);
    return ev;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /**
   * 计算一个订阅者需要补发的事件。
   * reset=true 表示客户端的进度不可用（daemon 重启过，或者它落后太多、缺口已被挤出缓冲）。
   */
  replay(bootId: string | null, sinceSeq: number): { reset: boolean; events: EventEnvelope[] } {
    const oldest = this.buf.length ? this.buf[0].seq : this.seq + 1;
    const sameBoot = bootId === this.bootId;
    // 客户端要的是 sinceSeq+1；如果它比缓冲里最老的还早，中间就有缺口
    if (!sameBoot || sinceSeq + 1 < oldest || sinceSeq > this.seq) {
      return { reset: true, events: [...this.buf] };
    }
    return { reset: false, events: this.buf.filter((e) => e.seq > sinceSeq) };
  }
}
