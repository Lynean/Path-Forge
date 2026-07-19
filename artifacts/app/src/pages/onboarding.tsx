import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useUpsertProfile, getGetProfileQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { INTEREST_OPTIONS, EXPERIENCE_QUESTIONS, LANGUAGE_OPTIONS, OTHER_KEY, buildProfileSummary } from "@/lib/profile-questions";

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const [step, setStep] = useState(1);
  const [age, setAge] = useState("");
  const [educationLevel, setEducationLevel] = useState("");
  const [major, setMajor] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState("");

  const [selectedInterests, setSelectedInterests] = useState<string[]>([]);
  const [otherInterest, setOtherInterest] = useState("");

  const [experienceByKey, setExperienceByKey] = useState<Record<string, string>>({});
  const [otherExperience, setOtherExperience] = useState("");

  const queryClient = useQueryClient();
  const upsertProfile = useUpsertProfile();

  const toggleInterest = (key: string, checked: boolean) => {
    setSelectedInterests((prev) => (checked ? [...prev, key] : prev.filter((k) => k !== key)));
  };

  const hasOtherInterest = selectedInterests.includes(OTHER_KEY);
  const canProceedStep2 = selectedInterests.length > 0 && (!hasOtherInterest || otherInterest.trim().length > 0);

  const handleNext = () => setStep((s) => Math.min(s + 1, 3));
  const handleBack = () => setStep((s) => Math.max(s - 1, 1));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const profileSummary = buildProfileSummary({
      selectedInterestKeys: selectedInterests.filter((k) => k !== OTHER_KEY),
      otherInterest,
      experienceByKey,
      otherExperience,
    });
    upsertProfile.mutate(
      {
        data: {
          age: age ? parseInt(age, 10) : null,
          educationLevel: educationLevel || null,
          major: major || null,
          preferredLanguage: preferredLanguage || null,
          profileSummary,
          isComplete: true
        }
      },
      {
        onSuccess: (savedProfile) => {
          // The profile query is shared by App.tsx's auth gate and the profile page —
          // without this, both keep serving whatever was cached before onboarding ran
          // (often "no profile"/404) until an unrelated refetch happens to occur.
          queryClient.setQueryData(getGetProfileQueryKey(), savedProfile);
          setLocation("/projects");
        }
      }
    );
  };

  const realSelectedInterests = selectedInterests.filter((k) => k !== OTHER_KEY);

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-xl border-border">
        <CardHeader>
          <CardTitle className="font-mono">Setup Profile</CardTitle>
          <CardDescription>Step {step} of 3</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={step === 3 ? handleSubmit : (e) => { e.preventDefault(); handleNext(); }} className="space-y-6">
            {step === 1 && (
              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                <div className="space-y-2">
                  <Label htmlFor="age">Age (Optional)</Label>
                  <Input
                    id="age"
                    type="number"
                    value={age}
                    onChange={(e) => setAge(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Education Level</Label>
                  <Select
                    value={educationLevel}
                    onValueChange={setEducationLevel}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select level" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="High School">High School</SelectItem>
                      <SelectItem value="Bachelor's">Bachelor's</SelectItem>
                      <SelectItem value="Master's">Master's</SelectItem>
                      <SelectItem value="PhD">PhD</SelectItem>
                      <SelectItem value="Self-taught">Self-taught</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="major">Major / Field</Label>
                  <Input
                    id="major"
                    value={major}
                    onChange={(e) => setMajor(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Preferred Language</Label>
                  <Select
                    value={preferredLanguage}
                    onValueChange={setPreferredLanguage}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select language" />
                    </SelectTrigger>
                    <SelectContent>
                      {LANGUAGE_OPTIONS.map((lang) => (
                        <SelectItem key={lang} value={lang}>{lang}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                <div className="space-y-3">
                  <Label>What areas of tech or science interest you? (select all that apply)</Label>
                  <div className="grid sm:grid-cols-2 gap-2.5">
                    {INTEREST_OPTIONS.map((opt) => (
                      <label
                        key={opt.key}
                        className="flex items-start gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:border-primary/50 transition-colors"
                      >
                        <Checkbox
                          checked={selectedInterests.includes(opt.key)}
                          onCheckedChange={(checked) => toggleInterest(opt.key, checked === true)}
                          className="mt-0.5"
                        />
                        <span className="text-sm leading-tight">{opt.label}</span>
                      </label>
                    ))}
                    <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:border-primary/50 transition-colors">
                      <Checkbox
                        checked={hasOtherInterest}
                        onCheckedChange={(checked) => toggleInterest(OTHER_KEY, checked === true)}
                        className="mt-0.5"
                      />
                      <span className="text-sm leading-tight">Other...</span>
                    </label>
                  </div>
                  {hasOtherInterest && (
                    <Input
                      autoFocus
                      placeholder="Tell us what else interests you"
                      value={otherInterest}
                      onChange={(e) => setOtherInterest(e.target.value)}
                    />
                  )}
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 max-h-[50vh] overflow-y-auto pr-1">
                {realSelectedInterests.map((key) => {
                  const q = EXPERIENCE_QUESTIONS[key];
                  const optLabel = INTEREST_OPTIONS.find((o) => o.key === key)?.label;
                  if (!q) return null;
                  return (
                    <div key={key} className="space-y-2">
                      <Label>{optLabel} — {q.question}</Label>
                      <RadioGroup
                        value={experienceByKey[key] ?? ""}
                        onValueChange={(val) => setExperienceByKey((prev) => ({ ...prev, [key]: val }))}
                      >
                        {q.options.map((opt) => (
                          <label key={opt} className="flex items-center gap-2 text-sm cursor-pointer">
                            <RadioGroupItem value={opt} />
                            {opt}
                          </label>
                        ))}
                      </RadioGroup>
                    </div>
                  );
                })}
                {hasOtherInterest && (
                  <div className="space-y-2">
                    <Label htmlFor="other-experience">Experience with "{otherInterest}"</Label>
                    <Input
                      id="other-experience"
                      placeholder="Briefly describe your experience"
                      value={otherExperience}
                      onChange={(e) => setOtherExperience(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-between pt-4">
              <Button type="button" variant="outline" onClick={handleBack} disabled={step === 1}>
                Back
              </Button>
              <Button type="submit" disabled={upsertProfile.isPending || (step === 2 && !canProceedStep2)}>
                {step === 3 ? (upsertProfile.isPending ? "Saving..." : "Complete Profile") : "Next"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
