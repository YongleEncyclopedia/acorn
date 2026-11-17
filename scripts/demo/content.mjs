/**
 * The demo library: four sources that do not exist, written for screenshots (README, docs). Everything here is
 * fiction — the sites live under .example, a name reserved for exactly this — and scripts/demo/run.mjs serves
 * them locally. `hoursAgo` places each article relative to when the library is built, so it always looks fresh.
 */

const p = (...lines) => lines.map((l) => `<p>${l}</p>`).join("\n");
const h2 = (t) => `<h2>${t}</h2>`;
const img = (site, name, caption) => `<figure><img src="http://${site}/img/${name}.jpg" alt="${caption}"><figcaption>${caption}</figcaption></figure>`;

export const SITES = {
  squirrel: { host: "squirrel-weekly.example", title: "松鼠周刊", description: "关于收藏、阅读与慢生活的周刊", icon: { bg: "#8A5A2B", char: "松" } },
  field: { host: "fieldnotes.example", title: "Field Notes", description: "Essays on woods, birds and the things we keep", icon: { bg: "#3F6B4E", char: "F" } },
  daily: { host: "linjian-daily.example", title: "林间日报", description: "城南一带的小事", icon: { bg: "#2F7A82", char: "林" } },
  campus: { host: "jwc.chengnan-u.example", title: "城南大学教务处", description: "通知公告", icon: { bg: "#2B4C8C", char: "城" } },
};

/** Landscapes for the articles: layered hills under a sun, in the palette of a season. */
export const IMAGES = {
  dusk: { sky: ["#F4D9B8", "#F7E9D7"], sun: "#FFF4E2", hills: ["#E3B27F", "#C98B57", "#A8663A", "#7E4A2B"] },
  mist: { sky: ["#DCE4EC", "#EEF2F5"], sun: "#FFFFFF", hills: ["#B8C6D3", "#93A6B9", "#6F859C", "#4C5F75"] },
  spring: { sky: ["#E5EFD9", "#F3F7EC"], sun: "#FFFDF3", hills: ["#B9D3A0", "#8DB47A", "#5E8F58", "#3E6B41"] },
  evening: { sky: ["#D9D2E6", "#EDE8F3"], sun: "#FFF5E8", hills: ["#B6A6CB", "#9182AE", "#6E6190", "#4D4470"] },
  ginkgo: { sky: ["#F6E7B5", "#FBF3DA"], sun: "#FFFBEE", hills: ["#EBC75E", "#D7A73A", "#B68327", "#8B611C"] },
  lamp: { sky: ["#2D3142", "#41465C"], sun: "#F6D69A", hills: ["#555B73", "#454A60", "#363A4D", "#26293A"] },
  lake: { sky: ["#D3E7E4", "#ECF5F3"], sun: "#FFFFFF", hills: ["#A6CEC8", "#7BB0AB", "#558F8C", "#3A6D6D"] },
};

export const ARTICLES = [
  // ───────── 松鼠周刊 ─────────
  {
    id: "forgotten-acorns",
    site: "squirrel",
    hoursAgo: 3,
    title: "被松鼠「忘记」的橡果",
    author: "松鼠周刊编辑部",
    image: "dusk",
    html: [
      p(
        "每年秋天，一只灰松鼠会把上千颗橡果分散埋进林地里。它不把粮食堆在一个洞里，而是一颗一颗地埋，每颗之间隔开几步远。到了第二年春天，总有一些橡果没有被挖出来，就在原地发了芽。",
        "于是有一种流传很广的说法：松鼠记性太差，橡树的繁衍全靠它们的健忘。这个说法只对了一半。",
      ),
      img("squirrel-weekly.example", "dusk", "秋天的林地，一年里松鼠最忙的时候"),
      h2("分散贮藏"),
      p(
        "动物学家把松鼠的做法叫作「分散贮藏」。粮仓分散了，即使被别的动物翻走几处，冬天也还有得吃；而一个集中的大粮仓，只要被发现一次，一冬的口粮就全没了。",
        "为了不让偷看的同类得手，松鼠还会做「假埋」：刨一个坑，装作把橡果放进去，再盖上土，嘴里的橡果却带去了别处。被人观察的时候，它们假埋得更勤。",
      ),
      h2("它的记性其实很好"),
      p(
        "实验里的松鼠能找回大部分自己埋下的橡果，比找别的松鼠埋的要准得多。它们靠的不只是气味，还有地标：一棵歪脖子树、一块石头、两条小路的交叉口。",
        "研究者发现，松鼠甚至会按种类分区存放：榛子放一片，橡果放另一片。分类之后，记起来更容易，就像我们把书按书架放好，比堆成一摞好找得多。",
      ),
      h2("被忘记的那几颗"),
      p(
        "那么，那些没被挖出来的橡果是怎么回事？也许那年冬天不冷，存粮够吃；也许它找到了更好的东西；也许它没能熬过冬天。被留在土里的，往往不是忘了，而是不再需要。",
        "一片橡树林就是这样长出来的：不是因为松鼠记不住，而是因为它们总是藏得比需要的多一点。",
      ),
      h2("读东西也是这样"),
      p(
        "我们收藏文章，也很像松鼠贮藏橡果：先收好，再慢慢消化。不是每一篇都会重读，但正因为藏得多一点，某个冬天的夜里，你才能在自己的硬盘上找到那篇早已从网上消失的文章。",
        "藏下的东西，偶尔会在春天发芽。",
      ),
    ].join("\n"),
  },
  {
    id: "winter-stores",
    site: "squirrel",
    hoursAgo: 27,
    title: "把信息当作冬粮：一个人的归档术",
    author: "林小满",
    image: "lake",
    html: [
      p("互联网看起来什么都记得，其实很健忘。几年前收藏的链接，今天点开，常常只剩一个空白页、一行「找不到这个页面」，或者一家早已改了名字的网站。"),
      h2("先藏，再说"),
      p(
        "我的办法很笨：读到值得留下的东西，当场存一份完整的副本，正文、图片、附件都在自己的硬盘上。不用想将来会不会再看，先藏起来。",
        "存得多了，就需要一点秩序。我只用三个标签：要再读的、要引用的、只是喜欢的。分类越少，越能坚持。",
      ),
      img("squirrel-weekly.example", "lake", "冬天来之前，把要用的东西先搬回家"),
      h2("定期回去看看"),
      p("每隔一段时间，我会回访存下来的原文。被删了的，标一个红色的「原文已消失」；被改过的，另存一个版本。看着那一小串红色标记，就知道当初没白存。"),
    ].join("\n"),
  },
  {
    id: "slow-reading",
    site: "squirrel",
    hoursAgo: 52,
    title: "秋天适合慢慢读完一本书",
    author: "周末",
    image: "evening",
    html: [
      p("夏天读书像赶路，秋天读书像散步。天凉下来，晚饭后多出一段安静的时间，正适合把一本拖了很久的书慢慢读完。"),
      h2("一次只读一章"),
      p(
        "我给自己定的规矩是：一次只读一章，读完就停，哪怕正读到兴头上。留一点悬念给明天，反而更容易每天回来。",
        "读到好句子就划下来，在旁边写一两句自己的想法。过几个月翻回来看，划线比书本身更像一本日记。",
      ),
      img("squirrel-weekly.example", "evening", "傍晚六点，一天里最适合翻开书的时候"),
      h2("别急着读完"),
      p(
        "有的书值得读得慢一点。读到一半放下，过一阵再拿起来，有时会发现自己已经不是放下它时的那个人了。",
        "进度条走得慢，没关系。秋天还长。",
      ),
    ].join("\n"),
  },
  {
    id: "study-lamp",
    site: "squirrel",
    hoursAgo: 75,
    title: "给书房装一盏好灯",
    author: "松鼠周刊编辑部",
    image: "lamp",
    html: [
      p("一盏好灯不必贵，但要满足三个条件：光要够亮，色温要暖，照在书页上不能有刺眼的反光。"),
      h2("色温与显色"),
      p("晚上读书，2700K 到 3000K 的暖光最舒服；显色指数在 90 以上，书页上的颜色才不会发灰。"),
      img("squirrel-weekly.example", "lamp", "一盏灯，一本书，一个冬天的晚上"),
      h2("放在哪里"),
      p("灯放在惯用手的另一侧，影子就不会落在纸上。写字用右手的人，把灯放在左前方。"),
    ].join("\n"),
  },
  // ───────── Field Notes ─────────
  {
    id: "accidental-foresters",
    site: "field",
    hoursAgo: 9,
    title: "Accidental Foresters",
    author: "Mara Ellison",
    image: "spring",
    html: [
      p(
        "Every autumn, a single jay can carry thousands of acorns away from the tree that dropped them. It buries each one alone, a few steps from the last, and comes back for most of them when the snow arrives.",
        "The ones it misses are not mistakes. They are how an oak wood moves uphill, one forgotten seed at a time.",
      ),
      img("fieldnotes.example", "spring", "Young oaks on a slope that had none thirty years ago"),
      h2("A forest planted by birds"),
      p(
        "Foresters in the Netherlands once counted the oaks that sprang up in a pine plantation and traced most of them to jays. No one had planted those trees. The birds had simply hidden more than they needed.",
        "A jay prefers to bury acorns at the edge of a clearing, where the soil is soft and the light is good. Those happen to be the best places for an oak to start.",
      ),
      h2("Keeping more than you need"),
      p(
        "It is tempting to call the surplus waste. But a store that is exactly as large as the winter ahead leaves nothing for a hard year, and nothing to grow.",
        "The habit of keeping a little more than we need is older than us, and it has planted more forests than we have.",
      ),
    ].join("\n"),
  },
  {
    id: "link-rot",
    site: "field",
    hoursAgo: 30,
    title: "Link Rot and the Case for Keeping Copies",
    author: "Mara Ellison",
    image: "mist",
    html: [
      p("Pages on the web disappear quietly. A blog moves to a new platform, a newspaper reorganizes its archive, a small site simply stops paying for its domain. The link still sits in your bookmarks, pointing at nothing."),
      h2("Half-lives"),
      p("Studies of academic citations find that a large share of links stop working within a decade. For personal bookmarks, the half-life is probably shorter: the smaller the site, the sooner it goes."),
      img("fieldnotes.example", "mist", "Fog over the valley, the morning after a storm"),
      h2("A copy of your own"),
      p("The only reliable bookmark is a copy you keep yourself: the text, the pictures, the date you saved it. It does not need to be clever. It needs to be yours."),
    ].join("\n"),
  },
  {
    id: "slow-field-guide",
    site: "field",
    hoursAgo: 98,
    title: "A Field Guide to Slow Reading",
    author: "Tom Ashby",
    image: "evening",
    html: [
      p("Read in the morning, before the day has an opinion. Read with a pencil. Stop at the end of a chapter even when you want to go on."),
      h2("Marks in the margin"),
      p("A margin note is a conversation with your future self. Write the question you had, not the answer you think you should have."),
    ].join("\n"),
  },
  // ───────── 林间日报 ─────────
  {
    id: "ginkgo",
    site: "daily",
    hoursAgo: 5,
    title: "城南公园银杏进入最佳观赏期",
    author: "林间日报",
    image: "ginkgo",
    html: [
      p("记者昨日从城南公园管理处获悉，园内两百余棵银杏已进入最佳观赏期，预计将持续到本月下旬。管理处提醒，周末游客较多，建议错峰前往。"),
      img("linjian-daily.example", "ginkgo", "城南公园东门的银杏大道"),
      p("今年秋季降温较晚，银杏转黄比往年晚了一周左右。园方表示，落叶将保留在步道两侧，不急于清扫。"),
    ].join("\n"),
  },
  {
    id: "cold-week",
    site: "daily",
    hoursAgo: 20,
    title: "本周降温，夜间最低气温将跌破五度",
    author: "林间日报",
    html: p("受冷空气影响，本周后半段气温明显下降，夜间最低气温将跌破五度。气象部门提醒市民及时添衣，早晚出行注意保暖。"),
  },
  {
    id: "book-market",
    site: "daily",
    hoursAgo: 44,
    title: "旧书市集周末开张，摊位比去年多一倍",
    author: "林间日报",
    image: "dusk",
    html: [
      p("一年一度的城南旧书市集将于本周六在老图书馆前的广场开张。今年报名的摊主有八十多家，比去年多了一倍，其中不少是第一次出摊的年轻人。"),
      img("linjian-daily.example", "dusk", "去年市集收摊前的最后一个小时"),
    ].join("\n"),
  },
  // ───────── 城南大学教务处 ─────────
  {
    id: "exam-schedule",
    site: "campus",
    hoursAgo: 26,
    title: "关于 2026—2027 学年第一学期期末考试安排的通知",
    author: "教务处",
    html: [
      p("各学院、各位同学：", "本学期期末考试将于 2027 年 1 月 4 日至 1 月 15 日进行。具体考试时间、地点请见附件，并以教务系统公布的为准。"),
      p('附件：<a href="http://jwc.chengnan-u.example/files/exam-schedule.pdf">2026—2027 学年第一学期期末考试安排表.pdf</a>'),
    ].join("\n"),
  },
  {
    id: "library-hours",
    site: "campus",
    hoursAgo: 70,
    title: "关于图书馆冬季开放时间调整的通知",
    author: "教务处",
    html: p("自 12 月 1 日起，图书馆一至三层阅览室开放时间调整为 8:00 至 22:30，期末考试期间延长至 23:30。"),
  },
];

/** Highlights on the demo's main article: what a reader marked, and what they wrote beside it. */
export const HIGHLIGHTS = [
  { article: "forgotten-acorns", quote: "粮仓分散了，即使被别的动物翻走几处，冬天也还有得吃", color: "amber", note: "存档也一样：不要只放在一个地方。" },
  { article: "forgotten-acorns", quote: "它们靠的不只是气味，还有地标", color: "green", note: null },
  { article: "forgotten-acorns", quote: "被留在土里的，往往不是忘了，而是不再需要。", color: "blue", note: "收藏夹里那些再也没打开过的，也许也是这样。" },
  { article: "forgotten-acorns", quote: "藏下的东西，偶尔会在春天发芽。", color: "rose", note: null },
];

/** What the demo's model answers: translations of the English article, line for line. */
export const TRANSLATIONS = {
  "Accidental Foresters": "无心插柳的护林人",
  "Link Rot and the Case for Keeping Copies": "链接会腐烂：为什么要自己留一份",
  "A Field Guide to Slow Reading": "慢读野外指南",
  "Every autumn, a single jay can carry thousands of acorns away from the tree that dropped them. It buries each one alone, a few steps from the last, and comes back for most of them when the snow arrives.":
    "每年秋天，一只松鸦能把成千上万颗橡果从落下它们的树旁带走。它把每一颗单独埋好，与上一颗相隔几步，等到下雪时再回来取走大部分。",
  "The ones it misses are not mistakes. They are how an oak wood moves uphill, one forgotten seed at a time.": "它漏掉的那些并不是失误。橡树林正是这样一颗被遗忘的种子接着一颗，慢慢爬上山坡的。",
  "Young oaks on a slope that had none thirty years ago": "三十年前还一棵橡树都没有的山坡，如今长满了小橡树",
  "A forest planted by birds": "鸟种下的森林",
  "Foresters in the Netherlands once counted the oaks that sprang up in a pine plantation and traced most of them to jays. No one had planted those trees. The birds had simply hidden more than they needed.":
    "荷兰的林务员曾经清点过一片松树人工林里自己冒出来的橡树，发现大多数都来自松鸦。没有人种过这些树，只是鸟儿藏下的比它们需要的多。",
  "A jay prefers to bury acorns at the edge of a clearing, where the soil is soft and the light is good. Those happen to be the best places for an oak to start.":
    "松鸦喜欢把橡果埋在林间空地的边缘，那里土壤松软、光线充足，恰好也是一棵橡树最好的起点。",
  "Keeping more than you need": "比需要的多留一点",
  "It is tempting to call the surplus waste. But a store that is exactly as large as the winter ahead leaves nothing for a hard year, and nothing to grow.":
    "人们很容易把多出来的那部分叫作浪费。可是一份刚好够过冬的存粮，遇上难熬的年份就什么也剩不下，更不会长出什么来。",
  "The habit of keeping a little more than we need is older than us, and it has planted more forests than we have.": "比需要的多留一点，这个习惯比人类还古老，它种下的森林也比我们种下的多。",
};

/** What the demo's model answers when asked for key points. */
export const KEY_POINTS = {
  "forgotten-acorns": [
    "松鼠把橡果分散埋在几步之外的许多地方，叫作「分散贮藏」，被翻走几处也不至于挨饿。",
    "它们的记性其实很好，靠地标和分区存放能找回大部分橡果。",
    "没被挖出来的橡果多半是不再需要，而不是被忘记；橡树林就是这样长出来的。",
    "收藏文章也一样：多藏一点，原文消失后自己还有一份。",
  ],
  "accidental-foresters": [
    "一只松鸦每年秋天能分散埋下成千上万颗橡果，大部分会在冬天取回。",
    "荷兰一片松树林里自己长出的橡树，大多来自松鸦漏掉的橡果。",
    "多留一点存粮不是浪费：它让难熬的年份有余地，也让森林得以扩张。",
  ],
};
