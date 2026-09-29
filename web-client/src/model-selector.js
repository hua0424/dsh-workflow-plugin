import { createElement as h, useEffect, useState } from 'react'

/** 目录只是建议值：保留配置中已有、当前宿主未公布的 provider / model。 */
export function modelChoices(groups, provider, modelId) {
  const providers = groups.map(({ id, name }) => ({ id, name }))
  if (provider && !providers.some((item) => item.id === provider)) {
    providers.push({ id: provider, name: `${provider}（配置中的值）` })
  }
  const models = [...(groups.find((group) => group.id === provider)?.models ?? [])]
  if (modelId && !models.some((item) => item.id === modelId)) {
    models.push({ id: modelId, name: `${modelId}（配置中的值）` })
  }
  return { providers, models }
}

/** 读取与 DSH 会话选择器相同的公开目录，不读取 provider 凭据。 */
export async function readModelCatalog(remote) {
  if (typeof remote?.session?.modelCatalog !== 'function') throw new Error('当前宿主未提供模型目录')
  let timer
  try {
    const response = await Promise.race([
      remote.session.modelCatalog(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('模型目录请求超过 15 秒，请重试')), 15_000) }),
    ])
    if (!response.ok) throw new Error(response.error?.message ?? '无法读取模型目录')
    return response.value
  } finally {
    clearTimeout(timer)
  }
}

export function ModelFields({ form, setForm, loadModels, busy, onApply, onClear }) {
  const [catalog, setCatalog] = useState({ groups: [], failures: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    Promise.resolve().then(() => {
      if (typeof loadModels !== 'function') throw new Error('当前宿主未提供模型目录')
      return loadModels()
    }).then((value) => { if (active) setCatalog(value) },
      (reason) => { if (active) setError(String(reason.message ?? reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [loadModels, revision])
  const { providers, models } = modelChoices(catalog.groups, form.provider, form.modelId)
  const field = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }))
  const select = (label, value, entries, onChange) => h('label', { className: 'wf-field' }, label,
    h('select', { value, onChange, disabled: busy || loading, 'aria-label': label },
      h('option', { value: '' }, '请选择'),
      entries.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
    ),
  )
  return h('div', { className: 'wf-model-fields' },
    select('模型 provider', form.provider, providers, (event) => {
      const provider = event.target.value
      setForm((previous) => ({ ...previous, provider, modelId: '', effort: '' }))
    }),
    select('modelId', form.modelId, models, (event) => {
      const modelId = event.target.value
      setForm((previous) => ({ ...previous, modelId, effort: '' }))
    }),
    h('label', { className: 'wf-field' }, 'reasoningEffort（留空=未指定）',
      h('input', { value: form.effort, onChange: field('effort'), disabled: busy })),
    h('div', { className: 'wf-actions' },
      h('button', { onClick: onApply, disabled: busy || !form.provider || !form.modelId }, '应用模型'),
      h('button', { onClick: onClear, disabled: busy }, '清除模型'),
      h('button', { onClick: () => setRevision((value) => value + 1), disabled: loading }, loading ? '加载模型…' : '刷新模型列表'),
    ),
    h('small', null, '来自 DSH 会话模型列表；清除模型后使用工作流的继承规则。'),
    error && h('p', { role: 'alert' }, error),
    catalog.failures.map((failure) => h('p', { key: failure.id, role: 'status' }, `${failure.name}：${failure.message}`)),
  )
}
