const SAFE_TERMS:ReadonlyArray<readonly[RegExp,string]>=[
  [/中国地图|全国地图/gu,"抽象区域热力分布图"],
  [/实时监控|监控大屏/gu,"实时运营态势"],
];
export function providerSafeConceptText(value:string):string{
  return SAFE_TERMS.reduce((text,[pattern,replacement])=>text.replace(pattern,replacement),value.normalize("NFKC"));
}
