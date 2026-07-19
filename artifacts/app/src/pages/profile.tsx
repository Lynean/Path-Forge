import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetProfile, useUpsertProfile, getGetProfileQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { LANGUAGE_OPTIONS } from "@/lib/profile-questions";

export default function Profile() {
  const { data: profile, isLoading } = useGetProfile();
  const upsertProfile = useUpsertProfile();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({
    age: "",
    educationLevel: "",
    major: "",
    profileSummary: "",
    preferredLanguage: ""
  });

  useEffect(() => {
    if (profile) {
      setFormData({
        age: profile.age?.toString() || "",
        educationLevel: profile.educationLevel || "",
        major: profile.major || "",
        profileSummary: profile.profileSummary || "",
        preferredLanguage: profile.preferredLanguage || ""
      });
    }
  }, [profile]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    upsertProfile.mutate(
      {
        data: {
          age: formData.age ? parseInt(formData.age, 10) : null,
          educationLevel: formData.educationLevel || null,
          major: formData.major || null,
          profileSummary: formData.profileSummary,
          preferredLanguage: formData.preferredLanguage || null,
          isComplete: true
        }
      },
      {
        onSuccess: (savedProfile) => {
          // Keep the shared profile query (also read by App.tsx's auth gate) in sync so
          // other views don't keep serving pre-save data.
          queryClient.setQueryData(getGetProfileQueryKey(), savedProfile);
          toast({ title: "Profile updated" });
        }
      }
    );
  };

  if (isLoading) {
    return <div className="p-10 text-center text-muted-foreground">Loading profile...</div>;
  }

  return (
    <div className="p-6 md:p-10 max-w-3xl mx-auto">
      <h1 className="text-3xl font-mono font-bold tracking-tight mb-8">Learner Profile</h1>
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label htmlFor="age">Age</Label>
            <Input id="age" type="number" value={formData.age} onChange={(e) => setFormData({ ...formData, age: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Education Level</Label>
            <Select value={formData.educationLevel} onValueChange={(val) => setFormData({ ...formData, educationLevel: val })}>
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
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label>Preferred Language</Label>
            <Select value={formData.preferredLanguage} onValueChange={(val) => setFormData({ ...formData, preferredLanguage: val })}>
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
        
        <div className="space-y-2">
          <Label htmlFor="major">Major / Field</Label>
          <Input id="major" value={formData.major} onChange={(e) => setFormData({ ...formData, major: e.target.value })} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="profileSummary">Interests &amp; Experience</Label>
          <p className="text-xs text-muted-foreground">
            Generated from your onboarding answers — edit directly here, or redo the guided questions during{" "}
            <a href="/onboarding" className="underline hover:text-foreground">setup</a>.
          </p>
          <Textarea
            id="profileSummary"
            value={formData.profileSummary}
            onChange={(e) => setFormData({ ...formData, profileSummary: e.target.value })}
            className="min-h-[160px]"
          />
        </div>

        <div className="flex justify-end pt-4 border-t border-border">
          <Button type="submit" disabled={upsertProfile.isPending}>
            {upsertProfile.isPending ? "Saving..." : "Save Profile"}
          </Button>
        </div>
      </form>
    </div>
  );
}
