# 세희의 개인 공간

아이디와 비밀번호로 로그인하면 바로 업무 파일/폴더, 사진, 메모, 일정 화면을 엽니다.

사진 탭은 기존 R2 버킷의 모든 폴더에서 사진을 모아 보여줍니다. 사진 탭 업로드는 일반 `사진` 폴더에 원본을 한 번만 저장하고 파일 탭에서도 보입니다. 일반 다운로드는 원본을 그대로, 저용량 다운로드는 브라우저에서 가로 최대 500px의 비율 유지 JPG(품질 82%)로 변환합니다. 축소본은 R2에 추가 저장하지 않습니다. PNG의 투명 배경은 흰색이 되며 애니메이션은 정지 이미지가 됩니다. HEIC/TIFF 등 브라우저가 읽지 못하는 형식도 원본 다운로드는 가능합니다.
게스트 접근과 취미 메뉴는 제공하지 않습니다.
원본: https://github.com/ikjoo123/ikjoo123.github.io (d50fa24ecedb75174a4f04f5f8cbf14085b30039)
디자인과 기능을 참고했으며 원본 사용자의 꿈 기록/사진은 가져오지 않았습니다.

## Cloudflare 설정

- Worker: `ssaayy123-github-io`
- R2 바인딩 이름: `FILES`, 버킷: `ssaayy-files` (기존 버킷 그대로 사용)
- 설정 → Variables and Secrets: `AUTH_USER`(로그인 아이디), `AUTH_PASSWORD`(비밀 유형, 로그인/삭제 비밀번호)
- R2 액세스 키는 필요 없습니다. 비밀번호를 GitHub에 올리지 마세요.
- 모든 자료 조회와 수정에는 소유자 로그인이 필요합니다. 기존 게스트 토큰도 사용할 수 없습니다.
- 원본과 동일하게 파일 저장 한도는 9GB, 100MB 이상 파일은 확인 후 업로드합니다.

## 배포

Cloudflare Git 연결에서 이 저장소와 `main` 브랜치를 선택합니다.
빌드 명령: `npm run build`, 배포 명령: `npx wrangler deploy`.
Wrangler 설정에도 빌드 명령이 포함되어 있어 `npx wrangler deploy`만 실행해도 정적 페이지를 준비합니다.

직접 배포:

```sh
npm install
npx wrangler login
npx wrangler secret put AUTH_USER
npx wrangler secret put AUTH_PASSWORD
npm run deploy
```

Worker 주소: https://ssaayy123-github-io.stargril7.workers.dev
GitHub Pages 주소: https://ssaayy123.github.io (Pages에서 main / root 설정)
두 주소 모두 같은 Worker API와 R2 버킷을 사용합니다.

## 검증 및 로컬 실행

```sh
npm ci
npm test
npm run dev
```

로컬 `.dev.vars`에 테스트용 `AUTH_USER`, `AUTH_PASSWORD`를 설정합니다.
`wrangler dev`는 로컬 R2를 사용합니다. 운영 R2와 비밀번호는 이 저장소에 포함되지 않습니다.
