# 角色卡格式（规范）

> ⚠ 本文由 `core/card-spec.mjs` 的 `specToMarkdown()` **自动生成**。
> 要改格式请改那份 spec —— 有一道测试盯着本文与 spec 是否一致，手改本文会测试失败。

**格式版本**：`game-pet-agent/card@1`

## 设计立场

角色卡分两层，**只有 hard 层能被机器校验**：

- `meta` —— 标识与版本：由程序派生或用户指定，模型不许填
- `animation` —— 桌宠外观：画风与气质（气质决定需要哪些动作）
- `soft` —— 自由描写：喂给模型当表达依据，**不参与机器校验**
- `hard` —— 硬约束：会被校验器逐条检查，**只有这一层能验证**

「谁有资格填」是这套格式的核心：

| fill | 含义 |
|---|---|
| `derived` | 程序派生（如 id），**模型与用户都不该填** |
| `user` | 只能由用户指定（主观选择，没有"正确答案"可抽） |
| `model` | 模型可以提议填入；标了「需出处」的还必须给出能在原文里找到的引文 |

**模型不许新增字段。** 卡里出现 spec 未登记的字段会被告警 —— 要么删掉，要么先在 spec 里登记。

## meta —— 标识与版本：由程序派生或用户指定，模型不许填

| 字段 | 类型 | 必填 | 谁填 | 需出处 | 默认 | 说明 |
|---|---|---|---|---|---|---|
| `id` | string | ✅ | `derived` |  | —— | 稳定标识。由 name + game 派生，保证同一张卡每次生成同一个 id |
| `name` | string | ✅ | `user` |  | —— | 角色名（显示用） |
| `game` | string | ✅ | `user` |  | —— | 游戏标识。记忆按它归属 —— 不同游戏的记忆不会互相串 |
| `version` | int |  | `derived` |  | `1` | 卡格式版本，用于将来的迁移 |
| `draft` | boolean |  | `derived` |  | `false` | 是否还是草稿（hard 层没填完时为 true，界面据此提醒） |

**填表时的提问：**

- `name` —— 这个角色叫什么？
- `game` —— 这是哪款游戏？（随便一个稳定的名字即可，比如 someday）

## animation —— 桌宠外观：画风与气质（气质决定需要哪些动作）

| 字段 | 类型 | 必填 | 谁填 | 需出处 | 默认 | 说明 |
|---|---|---|---|---|---|---|
| `animation.temperament` | enum(lively / calm / cool) |  | `model` | ✅ | `"calm"` | 气质 —— 决定这个角色**需要哪些桌宠动作**：lively 要打招呼+高兴，calm 只要高兴，cool 要关心 |
| `animation.style` | enum(soft / pixel / line) |  | `user` |  | `"soft"` | 桌宠画风：soft 柔和 / pixel 像素 / line 线稿 |
| `animation.actions` | string[] |  | `user` |  | `[]` | 额外要求的动作（idle / idleBored / talk 本来就必需，不用写） |
| `animation.scale` | number |  | `user` |  | `1` | 桌宠显示尺寸倍率 |

**填表时的提问：**

- `animation.temperament` —— 这个角色的性格偏活泼、冷静，还是高冷？（只能填 lively / calm / cool 三个之一）

## soft —— 自由描写：喂给模型当表达依据，**不参与机器校验**

| 字段 | 类型 | 必填 | 谁填 | 需出处 | 默认 | 说明 |
|---|---|---|---|---|---|---|
| `persona.soft.personality` | string |  | `model` |  | —— | 性格描写。**喂给模型当表达依据，不参与机器校验** |
| `persona.soft.background` | string |  | `model` | ✅ | —— | 背景 / 官方人设。**原样搬运，不做"提炼"** —— 所以必须给出处 |
| `persona.soft.speechStyle` | string |  | `model` |  | —— | 说话风格的描写（短句 / 爱吐槽 / 用敬语 …） |

**填表时的提问：**

- `persona.soft.personality` —— 介绍一下这个角色的性格（可以概括，不必逐字引用）
- `persona.soft.background` —— 粘贴官方人设或背景介绍原文（这一格要指明出处）
- `persona.soft.speechStyle` —— 这个角色说话是什么风格？（可以概括）

## hard —— 硬约束：会被校验器逐条检查，**只有这一层能验证**

| 字段 | 类型 | 必填 | 谁填 | 需出处 | 默认 | 说明 |
|---|---|---|---|---|---|---|
| `persona.hard.speechTics` | string[] |  | `model` | ✅ | `[]` | 口癖片段。**单句没有不判错**，但整批都没出现会被统计出来（lintBatch 的 ticRate） |
| `persona.hard.forbiddenWords` | string[] |  | `model` | ✅ | `[]` | 这个角色**绝不会说**的词。出现即判 error —— 过不了校验就直接不说 |
| `persona.hard.addresses` | object |  | `model` | ✅ | `{}` | 称呼规则，形如 { player: "你" }。整句没用到只是 warning |
| `persona.hard.avgLength` | {min,max} |  | `model` | ✅ | `{"min":4,"max":40}` | 回复长度区间（按码点算）。超出即 error —— 太长的角色扮演最劝退 |
| `persona.hard.emojiPolicy` | enum(none / allow / require) |  | `user` |  | `"none"` | 表情策略：none 出现表情即 error；require 没有表情即 error |
| `persona.hard.mustMention` | stringArrayMap |  | `user` |  | `{}` | 特定场景必须提到的词，形如 { save: ["存档"] } |

**填表时的提问：**

- `persona.hard.speechTics` —— 这个角色的口癖是什么？（原文里最好有明确依据，比如"她的口癖是…"）（例：……才不是）
- `persona.hard.forbiddenWords` —— 这个角色绝不会说哪些词？（比如"从不说谢谢"）
- `persona.hard.addresses` —— 这个角色怎么称呼玩家？
- `persona.hard.avgLength` —— 这个角色说话长短如何？（话少就给小一点的 max）

## 空表（填表流程的物理形态）

填表时交给模型的**就是这份空表**：格子由 spec 决定，模型的职责只是把值填进去，
**没有机会决定"有哪些字段"**。没有依据的格子留 `null`，不要编。

```json
{
  "_format": "game-pet-agent/card@1",
  "_instructions": "只填下面的格子；没有依据的留 null，不要编",
  "name": null,
  "game": null,
  "animation": {
    "temperament": null,
    "style": null,
    "actions": null,
    "scale": null
  },
  "persona": {
    "soft": {
      "personality": null,
      "background": null,
      "speechStyle": null
    },
    "hard": {
      "speechTics": null,
      "forbiddenWords": null,
      "addresses": null,
      "avgLength": null,
      "emojiPolicy": null,
      "mustMention": null
    }
  }
}
```
