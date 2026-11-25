/** A push subscription's address and how to send to it (添加订阅 → 推送, and the subscription's settings). */
import { CopyLine } from "./CopyLine.tsx";

export function PushInfo({ token }: { token: string }) {
  const address = `${window.location.origin}/in/${token}`;
  const local = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
  return (
    <div className="push-info">
      <div className="form-row">
        <label className="lbl">推送地址</label>
        <CopyLine text={address} label="推送地址" />
        <div className="help">地址里有密钥，知道它的人都能往这里发消息，别公开。{local ? "在别的设备上用时，把 localhost 换成「设置 → 多设备」里列出的地址。" : ""}</div>
      </div>
      <div className="push-ways">
        <b>怎么发</b>
        <ul>
          <li>
            发 <code>POST</code>，内容是 JSON：<code>{`{"title": "标题", "text": "正文", "url": "链接"}`}</code>，三项至少有一项；也可以一次发一个列表。
          </li>
          <li>表单、纯文本也行（纯文本的第一行当标题）；只会打开网址的工具可以用 GET，把字段写在网址后面。</li>
          <li>iPhone 快捷指令：加一个「获取 URL 内容」，网址填上面的地址，方法选 POST，请求体选 JSON，加 title、text 两个字段。</li>
          <li>带上 <code>id</code> 字段，同一条消息发两次也只记一篇。</li>
        </ul>
        <pre className="push-example">{`curl -X POST ${address} \\\n  -H 'content-type: application/json' \\\n  -d '{"title": "测试", "text": "从命令行发来的第一条消息"}'`}</pre>
      </div>
    </div>
  );
}
