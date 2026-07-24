import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function HomeView() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>My Space 에 오신 것을 환영합니다 👋</CardTitle>
          <CardDescription>
            왼쪽 메뉴에서 기능을 선택하세요. 앞으로 메뉴는 계속 추가될
            예정입니다.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
