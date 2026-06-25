import { useState } from "react";
import { useLocation } from "wouter";
import { useUpsertProfile } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    age: "",
    educationLevel: "",
    major: "",
    interests: "",
    experience: ""
  });

  const upsertProfile = useUpsertProfile();

  const handleNext = () => setStep((s) => Math.min(s + 1, 3));
  const handleBack = () => setStep((s) => Math.max(s - 1, 1));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    upsertProfile.mutate(
      {
        data: {
          age: formData.age ? parseInt(formData.age, 10) : null,
          educationLevel: formData.educationLevel || null,
          major: formData.major || null,
          interests: formData.interests,
          experience: formData.experience,
          isComplete: true
        }
      },
      {
        onSuccess: () => setLocation("/projects")
      }
    );
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg border-border">
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
                    value={formData.age} 
                    onChange={(e) => setFormData({ ...formData, age: e.target.value })} 
                  />
                </div>
                <div className="space-y-2">
                  <Label>Education Level</Label>
                  <Select 
                    value={formData.educationLevel} 
                    onValueChange={(val) => setFormData({ ...formData, educationLevel: val })}
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
                    value={formData.major} 
                    onChange={(e) => setFormData({ ...formData, major: e.target.value })} 
                  />
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                <div className="space-y-2">
                  <Label htmlFor="interests">Interests</Label>
                  <Textarea 
                    id="interests" 
                    placeholder="What areas of tech or science interest you? (e.g. robotics, web dev, graphics)"
                    value={formData.interests}
                    onChange={(e) => setFormData({ ...formData, interests: e.target.value })}
                    className="min-h-[120px]"
                  />
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                <div className="space-y-2">
                  <Label htmlFor="experience">Current Experience</Label>
                  <Textarea 
                    id="experience" 
                    placeholder="Describe your current skill level (e.g. 2 years Python, some C, never touched networking)"
                    value={formData.experience}
                    onChange={(e) => setFormData({ ...formData, experience: e.target.value })}
                    className="min-h-[120px]"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-between pt-4">
              <Button type="button" variant="outline" onClick={handleBack} disabled={step === 1}>
                Back
              </Button>
              <Button type="submit" disabled={upsertProfile.isPending}>
                {step === 3 ? (upsertProfile.isPending ? "Saving..." : "Complete Profile") : "Next"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
