// 零依赖叶子模块：经 pricing.ts 进入浏览器 bundle，禁止导入 node 内建
export function canonicalModelName(model: string) {
  return /^glm-\d+[.-]\d+(?:-|$)/i.test(model)
    ? model.toLowerCase().replace(/^(glm-\d+)[.-](\d+)(?=-|$)/, '$1.$2')
    : model;
}
