# Web 3D Viewer

STEP, IGES, STL 같은 3D CAD/메쉬 파일과 DWG, DXF 2D 도면을 브라우저에서 바로 여는 웹 뷰어입니다.
파일은 서버로 업로드되지 않고 모두 브라우저(WebAssembly + WebGL) 안에서 처리됩니다.

## 지원 형식

| 구분 | 형식 | 엔진 |
| --- | --- | --- |
| B-rep CAD | STEP / STP, IGES / IGS, BREP | [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade WASM) |
| 메쉬 | STL, OBJ(+MTL), glTF / GLB (Draco, Meshopt), FBX, PLY, 3MF, DAE, 3DS, AMF, VRML, VTK | three.js 로더 |
| 점군 | XYZ, PCD, PLY | three.js 로더 |
| 2D 도면 | DWG | [libredwg-web](https://github.com/mlightcad/libredwg-web) (LibreDWG WASM) |
| 2D 도면 | DXF (ASCII) | [dxf-parser](https://github.com/gdsestimating/dxf-parser) |

## 기능

**기본 뷰어 기능**
- 회전 / 이동 / 커서 기준 확대, 더블클릭으로 회전 중심 지정
- 전체 보기, 선택 확대, 표준 뷰(정면·배면·좌·우·평면·저면·등각 4방향), 뷰 큐브
- 원근 / 직교 투영 전환
- 표시 모드: 음영, 음영+모서리, 와이어프레임, 모서리만, X-Ray
- X / Y / Z 단면(클리핑) — 위치 슬라이더, 방향 반전, 평면 표시
- 측정: 거리(연속 거리), 각도, 좌표, 면적 — 정점, 끝점, 중간점 자동 스냅
- 모델 트리(어셈블리 구조), 검색, 표시/숨기기, 선택만 보기, 모두 보기
- 속성: 크기, 중심, 표면적, 부피, 삼각형 수, B-rep 면 수, 색상 및 불투명도 변경
- 그리드, 좌표축, 배경 4종, 스크린샷(PNG), 전체 화면, 단축키

**3D 요소 분해 / 분리**
- 분해(Explode) 슬라이더: 모든 부품을 모델 중심에서 바깥쪽으로 펼침
- 분리 이동 / 회전: 선택한 부품을 기즈모로 드래그해서 떼어냄. 기즈모는 부품 중심에 놓임
- 연결 요소로 분할: 단일 메쉬(STL 등)를 서로 떨어진 덩어리 단위로 나눔
- 면(Face) 단위 분할: STEP/IGES 바디를 B-rep 면 단위로 나눔
- 선택 부품 / 전체를 STL, GLB로 내보내기

**2D 도면 (DWG / DXF)**
- LINE, (LW)POLYLINE(bulge 포함), CIRCLE, ARC, ELLIPSE, SPLINE(NURBS), TEXT, MTEXT, INSERT(중첩·배열 블록), DIMENSION, SOLID, 3DFACE, HATCH(DWG), POINT, LEADER
- BYLAYER / BYBLOCK 색상, OCS(돌출 방향) 변환, 원점에서 멀리 떨어진 좌표의 정밀도 보정
- 레이어 패널(켜기/끄기, 단독 표시), 객체 선택과 속성 표시, 2D 측정
- 밝은 배경에서는 흰색 선을 검정으로 자동 전환

## 사용법

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ 에 정적 파일 생성
```

`dist/`는 정적 호스팅(Nginx 등)에 그대로 올리면 됩니다. 저장소 루트의 소스를 그대로 서비스하면 빌드되지 않은 `/src/main.js`를 불러오게 되어 화면이 깨지므로, 반드시 빌드 결과물을 배포하세요.

**GitHub Pages**: `npm run deploy`를 실행하면 빌드 후 `gh-pages` 브랜치로 푸시합니다. 저장소 Settings → Pages → Source를 *Deploy from a branch*, `gh-pages` / `(root)`로 설정하세요.
`?url=<파일 주소>` 파라미터로 원격 파일을 바로 열 수 있습니다. 이때 해당 서버가 CORS를 허용해야 합니다.

### 마우스 / 단축키

| 동작 | 입력 |
| --- | --- |
| 회전 (3D) | 왼쪽 드래그 |
| 이동 | 오른쪽 / 가운데 드래그 (2D는 왼쪽 드래그) |
| 확대 / 축소 | 휠 |
| 다중 선택 | Ctrl / Shift + 클릭 |
| 컨텍스트 메뉴 | 오른쪽 클릭 |
| 전체 / 선택 확대 | `F` |
| 표준 뷰 | `1`~`7` |
| 원근 / 직교 | `P` |
| 와이어프레임 / X-Ray | `W` / `X` |
| 숨기기 / 선택만 / 모두 보기 | `H` / `I` / `A` |
| 측정 / 단면 / 분해 | `M` / `S` / `E` |
| 분리 이동 / 회전 | `T` / `R` |
| 취소 / 선택 해제 | `Esc` |

## 구조

```
src/
  main.js              UI 연결 (툴바, 패널, 메뉴, 단축키)
  viewer.js            씬, 카메라, 표시 모드, 단면, 분해, 선택
  loaders/             형식별 로더 (index.js가 확장자로 분기)
    occt.js            STEP/IGES/BREP → 어셈블리 계층
    cad2d.js           DWG/DXF → 레이어별로 병합한 three.js 객체
  workers/             WASM 파싱은 Web Worker에서 실행 (UI 멈춤 방지)
  cad/normalize.js     DXF/DWG 엔티티 → 공통 테셀레이션 모델
  tools/measure.js     측정
  tools/split.js       연결 요소 / B-rep 면 분할, 형상 통계
  ui/                  모델 트리, 레이어 목록, 뷰 큐브, 아이콘
```

## 제한 사항

- 바이너리 DXF는 지원하지 않습니다. ASCII DXF로 저장해서 여세요.
- DXF의 HATCH는 dxf-parser가 지원하지 않아 표시되지 않습니다. DWG의 HATCH는 표시됩니다.
- 패턴 해치는 패턴 선 대신 반투명 채우기로 표시됩니다.
- 2D 도면은 모델 공간만 표시합니다. 배치(Layout) 공간은 표시하지 않습니다.
- 단면에 캡(절단면 채우기)은 그리지 않습니다.

## 라이선스

GPL-3.0. DWG 해석에 쓰는 LibreDWG(libredwg-web)가 GPL-3.0이라서 이 프로젝트도 GPL-3.0으로 배포합니다.
OpenCascade(occt-import-js)는 LGPL-2.1, three.js는 MIT 라이선스입니다.
