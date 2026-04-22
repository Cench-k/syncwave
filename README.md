---
title: SyncWave
emoji: 🌊
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# SyncWave

음성 파일과 대본을 정렬해 .srt / .vtt 자막을 생성하는 강제 정렬(Forced Alignment) 웹앱.

- **백엔드**: FastAPI + [aeneas](https://github.com/readbeyond/aeneas)
- **프론트엔드**: Next.js 15 + wavesurfer.js + Tailwind
- **지원**: 한국어 / 일본어 · 1~30분 · .mp3/.wav (≤50MB) + .txt

---

## 1. Prerequisites

### Windows에서 aeneas 설치 (가장 까다로운 부분)

aeneas는 네이티브 의존성이 많고, 한국어/일본어 지원도 수동 패치가 필요합니다. 본 프로젝트는 이를 자동화해두었지만 시스템 도구는 직접 설치해야 합니다.

| 도구 | 설치 방법 (winget) | 비고 |
| --- | --- | --- |
| Python 3.11 | `winget install Python.Python.3.11` | 3.12+에서는 numpy.distutils 제거로 빌드 실패 |
| eSpeak NG | `winget install eSpeak-NG.eSpeak-NG` | 한/일 음성 데이터 포함 |
| ffmpeg | `winget install Gyan.FFmpeg` | 또는 직접 다운로드 |
| MSVC C++ 워크로드 | VS Installer에서 "C++로 데스크톱 개발" 추가 | 또는 `Microsoft.VisualStudio.2022.BuildTools` |

설치 검증:
```bash
py -3.11 --version
"C:\Program Files\eSpeak NG\espeak-ng.exe" --version
ffmpeg -version
```

> **알려진 함정** — 본 프로젝트의 `app/aligner.py`에서 자동 처리되는 부분:
> 1. **aeneas의 setup.py 버그**: `INCLUDE_DIRS = [misc_util.get_numpy_include_dirs()]`이 리스트를 한 번 더 감싸 `-I['...']` 형태의 잘못된 컴파일러 플래그 생성. 설치 시 setup.py의 해당 라인에서 외부 `[]`를 제거해야 함.
> 2. **cew 확장 모듈 비활성화**: eSpeak NG는 `libespeak-ng.lib`로 제공되는데 cew는 `espeak.lib`를 찾음. `set AENEAS_WITH_CEW=False`로 끄고 설치 (정렬 품질에 영향 없음 — subprocess로 espeak-ng 호출).
> 3. **한/일 언어 매핑 누락**: aeneas의 espeak-ng 래퍼에 `kor`/`jpn` 매핑이 없음. `aligner.py`가 import 시점에 `LANGUAGE_TO_VOICE_CODE` dict에 mappings 주입.
> 4. **vcvarsall.bat 대신 VsDevCmd.bat 사용**: vswhere.exe가 PATH에 없으면 vcvarsall이 SDK 설정을 누락. VsDevCmd가 더 안정적.

### Node.js
- Node 20+ 권장.

---

## 2. Backend 실행

### 2-1. venv 생성 + 기본 의존성

```bash
cd backend
py -3.11 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip setuptools wheel "numpy<2"
.venv\Scripts\python.exe -m pip install fastapi==0.115.0 "uvicorn[standard]==0.32.0" python-multipart==0.0.12 pydub==0.25.1 apscheduler==3.10.4
```

### 2-2. aeneas 설치 (수동 패치 필요)

PowerShell:
```powershell
# 1. aeneas 소스 다운로드 + 압축 해제
.\.venv\Scripts\python.exe -m pip download aeneas==1.7.3.0 --no-deps --no-binary=:all: --dest $env:TEMP\aeneas-src --no-build-isolation
tar -xzf $env:TEMP\aeneas-src\aeneas-1.7.3.0.tar.gz -C $env:TEMP\aeneas-src

# 2. setup.py 패치 (line 198 외부 대괄호 제거)
(Get-Content $env:TEMP\aeneas-src\aeneas-1.7.3.0\setup.py) `
  -replace '\[misc_util\.get_numpy_include_dirs\(\)\]', 'misc_util.get_numpy_include_dirs()' `
  | Set-Content $env:TEMP\aeneas-src\aeneas-1.7.3.0\setup.py

# 3. VsDevCmd 환경에서 cew 비활성화 후 설치
cmd /c '"C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 && set AENEAS_WITH_CEW=False && .venv\Scripts\python.exe -m pip install %TEMP%\aeneas-src\aeneas-1.7.3.0 --no-build-isolation'
```

### 2-3. 서버 기동

```bash
.venv\Scripts\uvicorn.exe app.main:app --reload --port 8000
```

확인: <http://localhost:8000/health> → `{"status":"ok"}`

---

## 3. Frontend 실행

```bash
cd frontend
npm install
npm run dev
```

브라우저: <http://localhost:3000>

`NEXT_PUBLIC_API_BASE` 환경변수로 백엔드 URL을 변경할 수 있습니다 (기본 `http://localhost:8000`).

---

## 4. 사용 방법

1. 홈 화면에서 음성(.mp3/.wav)과 대본(.txt)을 드래그 앤 드롭 또는 선택.
2. 언어를 선택하고 **싱크 맞추기** 클릭.
3. 정렬 결과가 워크스페이스에 표시됩니다.
   - 파형의 자막 블록을 드래그/리사이즈해 미세 조정.
   - 블록 클릭 시 해당 구간 재생.
   - 대본 리스트에서 텍스트 직접 편집 (focus out 시 반영).
   - Space: 재생/정지, ←/→: 5초 이동.
4. **.srt** 또는 **.vtt** 다운로드.

> 대본은 **줄바꿈 단위로 한 자막 블록**이 됩니다. 빈 줄은 무시됩니다.

---

## 5. 데이터 보안 정책

- 업로드 파일은 임시 폴더(`backend/temp/<uuid>/`)에 저장.
- 정렬 완료(또는 실패) 즉시 해당 폴더 삭제.
- 1시간마다 잔여 임시 파일 정리 (APScheduler).
- 작업 내역은 브라우저 localStorage에 1분마다 자동 저장 (서버 DB 없음).

---

## 6. 배포: HuggingFace Spaces (Docker, 무료)

이 저장소는 단일 Docker 컨테이너에 프론트(정적 export) + 백엔드(FastAPI + aeneas)를 모두 담아 HuggingFace Spaces에서 바로 동작합니다.

### 6-1. Space 생성

1. <https://huggingface.co/new-space> 에서 새 Space 생성.
2. **SDK = Docker**, Space hardware = `cpu-basic` (무료) 선택.
3. 만든 Space의 git 저장소를 클론.

### 6-2. 코드 푸시

```bash
# 이 저장소 내용을 Space의 git 저장소로 복사 후
git add .
git commit -m "deploy: initial"
git push
```

빌드는 5~10분 정도 걸립니다 (aeneas 컴파일 포함). 빌드 로그는 Space 페이지 → "Logs" 탭에서 확인.

### 6-3. 비밀번호 보호 (개인용)

Space 페이지 → **Settings → Variables and secrets** 에서 secret 추가:

| 키 | 값 | 비고 |
| --- | --- | --- |
| `APP_PASS` | (원하는 비밀번호) | 설정 시 Basic Auth 활성화 |
| `APP_USER` | (선택) | 기본 빈 값 = username 미검증, 비밀번호만 체크 |

`APP_PASS`가 비어 있으면 인증 없이 누구나 접근할 수 있으니 개인용일 경우 반드시 설정.

### 6-4. 접속

`https://<your-username>-<space-name>.hf.space` → 브라우저가 Basic Auth 다이얼로그를 띄웁니다.

### 6-5. 로컬에서 Docker 빌드 테스트

```bash
docker build -t syncwave .
docker run --rm -p 7860:7860 -e APP_PASS=test syncwave
# → http://localhost:7860 (id 비워두고 pw=test)
```

---

## 7. 디렉토리 구조

```
syncwave/
├── backend/
│   ├── app/
│   │   ├── main.py        # FastAPI 엔트리 + 정리 스케줄러
│   │   ├── aligner.py     # aeneas 강제 정렬 래퍼
│   │   └── cleanup.py     # 임시 폴더 sweep
│   ├── temp/              # 작업별 임시 폴더 (gitignore)
│   └── requirements.txt
└── frontend/
    ├── src/
    │   ├── app/           # Next.js App Router
    │   ├── components/    # UploadPanel, Workspace, Waveform, ScriptList
    │   └── lib/           # api, format(srt/vtt), storage, types
    ├── package.json
    └── tailwind.config.ts
```
